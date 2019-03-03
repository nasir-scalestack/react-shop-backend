const bcrypt = require('bcryptjs');
const { randomBytes } = require('crypto');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');
const { hasPermission } = require('../utils');
const  { transport, makeANiceEmail } = require('../mail');
const stripe = require('../stripe');

const Mutations = {
  async createItem(parent, args, ctx, info) {
    if(!ctx.request.userId){
      throw new Error("you must be logged in to do that");
    }

    const item = await ctx.db.mutation.createItem(
      {
        data: {
          // this is how we provide relationship
          user: {
            connect: {
              id: ctx.request.userId
            }
          },
          ...args,
        },
      },
      info
    );

    return item;
  },
  async updatePermissions(parent, args, ctx, info) {
    // 1. Check if they are logged in
    if (!ctx.request.userId) {
      throw new Error('You must be logged in!');
    }
    // 2. Query the current user
    const currentUser = await ctx.db.query.user(
      {
        where: {
          id: ctx.request.userId,
        },
      },
      info
    );
    // 3. Check if they have permissions to do this
    hasPermission(currentUser, ['ADMIN', 'PERMISSIONUPDATE']);
    // 4. Update the permissions
    return ctx.db.mutation.updateUser(
      {
        data: {
          permissions: {
            set: args.permissions,
          },
        },
        where: {
          id: args.userId,
        },
      },
      info
    );
  },
  updateItem(parent, args, ctx, info) {
    // first take a copy of the updates
    const updates = { ...args };
    // remove the id from the updates copy
    delete updates.id;
    // run the update method
    return ctx.db.mutation.updateItem({
      data: updates,
      where: {
        id: args.id
      }
    }, 
    info
    );
  },
  async deleteItem(parent, args, ctx, info) {
    const where = { id: args.id };
    // 1. find the item
    const item = await ctx.db.query.item({ where }, `{ id title user { id }}`);
    // 2. Check if they own that item, or have the permissions
    const ownsItem = item.user.id === ctx.request.userId;
    const hasPermissions = ctx.request.user.permissions.some(permission =>
      ['ADMIN', 'ITEMDELETE'].includes(permission)
    );

    if (!ownsItem && !hasPermissions) {
      throw new Error("You don't have permission to do that!");
    }

    // 3. Delete it!
    return ctx.db.mutation.deleteItem({ where }, info);
  },
  async signin(parent, { email, password }, ctx, info) {
    // 1. check if there is a user with that email
    const user = await ctx.db.query.user({ where: { email } });
    if (!user) {
      throw new Error(`No such user found for email ${email}`);
    }
    // 2. Check if their password is correct
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      throw new Error('Invalid Password!');
    }
    // 3. generate the JWT Token
    const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);
    // 4. Set the cookie with the token
    ctx.response.cookie('token', token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365,
    });
    // 5. Return the user
    return user;
  },
  async signup(parent, args, ctx, info) {
    // lower case their email
    args.email = args.email.toLowerCase();
    // hash their password
    const password = await bcrypt.hash(args.password, 10);
    // create the user in the db
    const user = await ctx.db.mutation.createUser({
      data: {
        ...args,
        password,
        permissions: { set: ['USER'] }
      }
    }, info);
    const token = jwt.sign({userId: user.id}, process.env.APP_SECRET);
    // we set the jwt as a cookie
    ctx.response.cookie('token', token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365,
    });
    return user;
  },
  async signout(parent, args, ctx, info) {
    ctx.response.clearCookie('token');
    return { message: 'Goodbye!'}
  },
  async requestReset(parent, args, ctx, info) {
    // 1. Check if this is a real user
    const user = await ctx.db.query.user({ where: { email: args.email } });
    if (!user) {
      throw new Error(`No such user found for email ${args.email}`);
    }
    // 2. Set a reset token and expiry on that user
    const randomBytesPromiseified = promisify(randomBytes);
    const resetToken = (await randomBytesPromiseified(20)).toString('hex');
    const resetTokenExpiry = Date.now() + 3600000; // 1 hour from now
    const res = await ctx.db.mutation.updateUser({
      where: { email: args.email },
      data: { resetToken, resetTokenExpiry },
    });
    // 3. Email them that reset token
    const mailRes = await transport.sendMail({
      from: 'support@reactshop.com',
      to: user.email,
      subject: 'Your Password Reset Token',
      html: makeANiceEmail(`Your Password Reset Token is here!
      \n\n
      <a href="${process.env
        .FRONTEND_URL}/reset?resetToken=${resetToken}">Click Here to Reset</a>`),
    });

    // 4. Return the message
    return { message: 'Thanks!' };
  },
  async resetPassword(parent, args, ctx, info){
    const passmatches = args.password === args.confirmPassword;
    if(!passmatches){
      throw new Error("Passwords do not match");
    } 

    const [user] = await ctx.db.query.users({
      where: { resetToken: args.resetToken, resetTokenExpiry_gte: Date.now() - 3600000 }
    });

    if(!user){
      throw new Error("Token is either invalid or expired");
    }

    const password = await bcrypt.hash(args.password, 10);
    const updatedUser = await ctx.db.mutation.updateUser({
      where: { email: user.email },
      data: {
        password,
        resetToken: null,
        resetTokenExpiry: null
      }
    });

    const token = jwt.sign({ userId: updatedUser.id }, process.env.APP_SECRET);
    ctx.response.cookie('token', token, {
      httpOnly: true, 
      maxAge: 1000 * 60 * 60 * 24 * 365,
    })

    return updatedUser;
  },
  async addToCart(parent, args, ctx, info) {
    // 1. Make sure they are signed in
    const { userId } = ctx.request;
    if (!userId) {
      throw new Error('You must be signed in soooon');
    }
    // 2. Query the users current cart
    const [existingCartItem] = await ctx.db.query.cartItems({
      where: {
        user: { id: userId },
        item: { id: args.id },
      },
    });
    // 3. Check if that item is already in their cart and increment by 1 if it is
    if (existingCartItem) {
      console.log('This item is already in their cart');
      return ctx.db.mutation.updateCartItem(
        {
          where: { id: existingCartItem.id },
          data: { quantity: existingCartItem.quantity + 1 },
        },
        info
      );
    }
    // 4. If its not, create a fresh CartItem for that user!
    return ctx.db.mutation.createCartItem(
      {
        data: {
          user: {
            connect: { id: userId },
          },
          item: {
            connect: { id: args.id },
          },
        },
      },
      info
    );
  },
  async removeFromCart(parent, args, ctx, info){
    // 1. find the cart item
    const cartItem = await ctx.db.query.cartItem({
      where: { 
        id: args.id
      }
    }, 
     `{ id, user { id }}` 
    );
    if(!cartItem) throw new Error("Item does not item");

    if(cartItem.user.id !== ctx.request.userId) throw new Error("Cheating huh?");

    return ctx.db.mutation.deleteCartItem({
      where: {
        id: args.id
      }
    }, info)
    // 2. make sure they own the cart item
    // 3. delete cart item
  },
  async createOrder(parent, args, ctx, info){
    const { userId } = ctx.request;
    if (!userId) {
      throw new Error('You must be signed in soooon');
    }
    const user = await ctx.db.query.user({ where: { id: userId }},
       `
       {
        id 
        name 
        email 
        cart { 
         id 
         quantity 
         item { 
           title 
           price 
           id 
           description 
           image
           largeImage
          }
        }
      }`
    );
    const amount = user.cart.reduce((tally, cartItem) => tally + cartItem.item.price * cartItem.quantity , 0);
    const charge = await stripe.charges.create({
      amount: amount,
      currency: 'CAD',
      source: args.token,
    })

    const orderItems = user.cart.map(cartItem => {
      const orderItem = {
        ...cartItem.item,
        largeImage: cartItem.item.image,
        quantity: cartItem.quantity,
        user: { 
          connect: { 
            id: userId 
          }
        }
      }
      delete orderItem.id;
      return orderItem;
    })

    const order = await ctx.db.mutation.createOrder({
      data: {
        total: charge.amount,
        charge: charge.id,
        items: { create: orderItems },
        user: { connect: { id: userId }}
      }
    })

    const cartItemIds = user.cart.map(cartItem => cartItem.id);
    await ctx.db.mutation.deleteManyCartItems({ where: {
      id_in: cartItemIds
    }});

    return order;
  }
};
  
module.exports = Mutations;