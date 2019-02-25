const { forwardTo } = require('prisma-binding');

const Query = {
  item: forwardTo('db'),
  items: forwardTo('db'),
  itemsConnection: forwardTo('db'),
  // async items(parent, args, ctx, info) {
  //   console.log('Getting Items!!');
  //   const items = await ctx.db.query.items();
  //   return items;
  // },
};

module.exports = Query;