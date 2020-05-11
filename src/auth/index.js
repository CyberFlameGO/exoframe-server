// npm packages
const fs = require('fs');
const {join} = require('path');
const {promisify} = require('util');
const jwt = require('jsonwebtoken');
const sshpk = require('sshpk');
const {v1: uuidv1} = require('uuid');

// our packages
const {auth} = require('../../config');
const {getConfig} = require('../config');
const {reqCollection, getTokenCollection} = require('../db');

// promisify readfile
const readFile = promisify(fs.readFile);
const jwtVerify = promisify(jwt.verify);

// path to keys
const keysFolder = getConfig().publicKeysPath;
const publicKeysPath = join(keysFolder, 'authorized_keys');

const verifyWithKey = async ({key, token, phrase}) => {
  try {
    const pk = sshpk.parseKey(key);
    const pubKey = pk.toString('pem');
    const decoded = await jwtVerify(token, pubKey, {algorithms: ['RS256']});
    return decoded === phrase;
  } catch (e) {
    return false;
  }
};

const loginRoutes = (fastify, opts, next) => {
  fastify.route({
    method: 'GET',
    path: '/',
    handler(request, reply) {
      const templatePath = join(__dirname, '..', 'templates', 'home.html');
      const template = fs.readFileSync(templatePath).toString();
      reply.header('Content-Type', 'text/html; charset=UTF-8').send(template);
    },
  });

  fastify.route({
    method: 'GET',
    path: '/login',
    async handler(request, reply) {
      // generate login request with phrase and uuid
      const uid = uuidv1();
      const doc = {phrase: `hello exoframe ${uid}`, uid};
      // store in request collection
      reqCollection.insert(doc);
      // send back to user
      reply.send(doc);
    },
  });

  fastify.route({
    method: 'POST',
    path: '/login',
    async handler(request, reply) {
      const {
        body: {user, token, requestId},
      } = request;
      const loginReq = reqCollection.findOne({uid: requestId});

      if (!token || !user) {
        reply.code(401).send({error: 'No token given!'});
        return;
      }

      if (!loginReq) {
        reply.code(401).send({error: 'Login request not found!'});
        return;
      }

      try {
        const publicKeysFile = await readFile(publicKeysPath);
        const publicKeys = publicKeysFile
          .toString()
          .split('\n')
          .filter(k => k && k.length > 0);
        const res = await Promise.all(publicKeys.map(key => verifyWithKey({key, token, phrase: loginReq.phrase})));
        if (!res.some(r => r === true)) {
          reply.code(401).send({error: 'Not authorized!'});
          return;
        }
      } catch (e) {
        reply.code(405).send({error: `Could not read public keys file! ${e.toString()}`});
        return;
      }

      // generate auth token
      const replyToken = jwt.sign({loggedIn: true, user}, auth.privateKey, {
        algorithm: 'HS256',
      });
      reply.send({token: replyToken});
    },
  });

  next();
};

const authRoutes = (fastify, opts, next) => {
  // enable auth for all routes
  fastify.addHook('preHandler', fastify.auth([fastify.verifyJWT]));

  fastify.route({
    method: 'GET',
    path: '/checkToken',
    handler(request, reply) {
      const replyObj = {
        message: 'Token is valid',
        credentials: request.user,
      };
      reply.send(replyObj);
    },
  });

  fastify.route({
    method: 'POST',
    path: '/deployToken',
    handler(request, reply) {
      // generate new deploy token
      const {tokenName} = request.body;
      const {user} = request;
      // generate new private key
      const token = jwt.sign({loggedIn: true, user, tokenName, deploy: true}, auth.privateKey, {
        algorithm: 'HS256',
      });
      // save token name to config
      getTokenCollection().insert({tokenName, user: user.username});
      // send back to user
      reply.send({token});
    },
  });

  fastify.route({
    method: 'GET',
    path: '/deployToken',
    handler(request, reply) {
      // generate new deploy token
      const {user} = request;
      // save token name to config
      const tokens = getTokenCollection().find({user: user.username});
      // send back to user
      reply.send({tokens});
    },
  });

  fastify.route({
    method: 'DELETE',
    path: '/deployToken',
    handler(request, reply) {
      // generate new deploy token
      const {tokenName} = request.body;
      const {user} = request;
      const existingToken = getTokenCollection().findOne({user: user.username, tokenName});
      if (!existingToken) {
        reply.code(200).send({removed: false, reason: 'Token does not exist'});
        return;
      }
      // remove token from collection
      getTokenCollection().remove(existingToken);
      // send back to user
      reply.code(204).send();
    },
  });

  next();
};

module.exports = fastify => {
  fastify.decorate('verifyJWT', (request, reply, done) => {
    const bearer = request.headers.authorization;
    if (!bearer) {
      return done(new Error('No authorization header provided!'));
    }
    const token = bearer.replace('Bearer ', '');
    if (!token || !token.length) {
      return done(new Error('No token provided!'));
    }
    let decodedToken;
    try {
      decodedToken = jwt.verify(token, auth.privateKey, {algorithms: ['HS256']});
    } catch (e) {
      return done(e);
    }
    if (!decodedToken) {
      return done(new Error('Decoded token invalid!'));
    }
    const {user, loggedIn, deploy, tokenName} = decodedToken;

    // set user to request
    request.user = user;

    // if it's a deployment token - check if it's still in db
    if (deploy) {
      const existingToken = getTokenCollection().findOne({tokenName, user: user.username});
      if (!existingToken) {
        return done(new Error('Deployment token not found!'));
      }
    }

    if (!user || !loggedIn) {
      return done(new Error('User not found or authorization expired!'));
    }

    return done();
  });

  return fastify.register(loginRoutes).register(authRoutes);
};
