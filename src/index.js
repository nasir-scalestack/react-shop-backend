require('dotenv').config({ path: 'variables.env'});

const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const createServer = require('./createServer');
const db = require('./db');

const server = createServer();

server.express.use(cookieParser());

// decode the jwt so we can get the user id on each req
server.express.use((req, res, next) => {
    const { token } = req.cookies;
    if(token) {
        const  { userid } = jwt.verify(token, process.env.APP_SECRET);
        // put the userid onto the request for further requests to access
        req.userId = userId;
    }
    next();
})

server.start({
    cors: {
        credentials: true,
        origin: process.env.FRONTEND_URL
    }
}, ({port}) => {
    console.log(`Server is now running on port http://localhost:${port}`);
});