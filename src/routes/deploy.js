/* eslint no-await-in-loop: off */
// npm modules
const _ = require('highland');
const {Readable} = require('stream');
const {v1: uuidv1} = require('uuid');

// our modules
const logger = require('../logger');
const util = require('../util');
const {getConfig, tempDockerDir, faasFolder} = require('../config');
const docker = require('../docker/docker');
const {pullImage, pruneDocker} = require('../docker/util');
const {build} = require('../docker/build');
const {start} = require('../docker/start');
const getTemplates = require('../docker/templates');
const {removeContainer} = require('../docker/util');
const {getPlugins} = require('../plugins');
const {registerFunction} = require('exoframe-faas');

// destruct locally used functions
const {sleep, cleanTemp, unpack, getProjectConfig, projectFromConfig} = util;

// time to wait before removing old projects on update
const WAIT_TIME = 5000;

// deployment from unpacked files
const deploy = async ({username, folder, existing, resultStream}) => {
  let template;
  // try getting template from config
  const config = getProjectConfig(folder);
  // get server config
  const serverConfig = getConfig();

  // generate template props
  const templateProps = {
    config,
    serverConfig: {...serverConfig, faasFolder},
    existing,
    username,
    resultStream,
    tempDockerDir,
    folder,
    docker: {
      daemon: docker,
      build,
      start,
      pullImage,
    },
    faas: {
      registerFunction,
    },
    util: Object.assign({}, util, {
      logger,
      getPlugins,
    }),
  };

  // get templates
  const templates = getTemplates();

  // match via config if possible
  if (config.template && config.template.length > 0) {
    logger.debug('Looking up template from config:', config.template);
    template = templates.find(t => t.name === config.template);
  } else {
    // find template using check logic
    for (let i = 0; i < templates.length; i++) {
      const t = templates[i];
      const isRightTemplate = await t.checkTemplate(templateProps);
      if (isRightTemplate) {
        template = t;
        break;
      }
    }
  }

  // if template not found - throw an error
  if (!template) {
    logger.debug(`Build failed! Couldn't find template: ${config.template}`);
    util.writeStatus(resultStream, {
      message: `Build failed! Couldn't find template: ${config.template}!`,
      level: 'error',
    });
    resultStream.end('');
    return;
  }

  logger.debug('Using template:', template);
  // execute fitting template
  await template.executeTemplate(templateProps);
};

// schedule docker prune for next tick (if enabled in config)
const schedulePrune = () => {
  // get server config
  const serverConfig = getConfig();
  if (serverConfig.autoprune) {
    process.nextTick(pruneDocker);
  }
};

const scheduleCleanup = ({username, project, existing}) => {
  process.nextTick(async () => {
    // wait a bit for it to start
    await sleep(WAIT_TIME);

    // get all current containers
    const containers = await docker.listContainers();
    // find containers for current user and project
    const running = containers.filter(
      c => c.Labels['exoframe.user'] === username && c.Labels['exoframe.project'] === project
    );

    // filter out old container that don't have new containers
    // that are already up and running
    const toRemove = existing.filter(container => {
      const newInstance = running.find(runningContainer =>
        util.compareNames(container.Labels['exoframe.name'], runningContainer.Labels['exoframe.name'])
      );
      return newInstance && newInstance.State === 'running' && newInstance.Status.toLowerCase().includes('up');
    });

    // remove old containers
    await Promise.all(toRemove.map(removeContainer));

    // if not done - schedule with remaining containers
    if (toRemove.length !== existing.length) {
      const notRemoved = existing.filter(c => !toRemove.find(rc => rc.Id === c.Id));
      scheduleCleanup({username, project, existing: notRemoved});
    }

    // run prune on next tick if enabled in config
    schedulePrune();
  });
};

module.exports = fastify => {
  fastify.route({
    method: 'POST',
    path: '/deploy',
    async handler(request, reply) {
      // get username
      const {username} = request.user;
      // get stream
      const tarStream = request.req;
      // create new deploy folder for user
      const folder = `${username}-${uuidv1()}`;
      // unpack to user specific temp folder
      await unpack({tarStream, folder});
      // create new highland stream for results
      const resultStream = _();
      // run deploy
      deploy({username, folder, resultStream}).then(() => schedulePrune());
      // reply with deploy stream
      const responseStream = new Readable().wrap(resultStream);
      reply.code(200).send(responseStream);
      // schedule temp folder cleanup on end
      responseStream.on('end', () => cleanTemp(folder));
    },
  });

  fastify.route({
    method: 'POST',
    path: '/update',
    async handler(request, reply) {
      // get username
      const {username} = request.user;
      // get stream
      const tarStream = request.req;
      // create new deploy folder for user
      const folder = `${username}-${uuidv1()}`;
      // unpack to temp user folder
      await unpack({tarStream, folder});
      // get old project containers if present
      // get project config and name
      const config = getProjectConfig(folder);
      const project = projectFromConfig({username, config});

      // get all current containers
      const oldContainers = await docker.listContainers({all: true});
      // find containers for current user and project
      const existing = oldContainers.filter(
        c => c.Labels['exoframe.user'] === username && c.Labels['exoframe.project'] === project
      );

      // create new highland stream for results
      const resultStream = _();
      // deploy new versions
      deploy({username, folder, payload: request.payload, resultStream});
      // reply with deploy stream
      const responseStream = new Readable().wrap(resultStream);
      reply.code(200).send(responseStream);
      // schedule temp folder and container cleanup on deployment end
      responseStream.on('end', () => {
        // schedule container cleanup
        scheduleCleanup({username, project, existing});
        // clean temp folder
        cleanTemp(folder);
      });
    },
  });
};
