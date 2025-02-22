const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');
const chokidar = require('chokidar');
const chalk = require('chalk');
const psTree = require('ps-tree');
const childProcess = require('child_process');
const detect = require('detect-port');
const project = require('yoshi-config');
const queries = require('./queries');
const { POM_FILE, MONOREPO_ROOT } = require('yoshi-config/paths');
const xmldoc = require('xmldoc');
const { staticsDomain } = require('./constants');

function logIfAny(log) {
  if (log) {
    console.log(log);
  }
}

module.exports.unprocessedModules = p => {
  const allSourcesButExternalModules = function(filePath) {
    filePath = path.normalize(filePath);

    if (project.experimentalMonorepoSubProcess) {
      return (
        filePath.startsWith(MONOREPO_ROOT) && !filePath.includes('node_modules')
      );
    }

    return (
      filePath.startsWith(process.cwd()) && !filePath.includes('node_modules')
    );
  };

  const externalUnprocessedModules = ['wix-style-react/src'].concat(
    project.externalUnprocessedModules,
  );

  const externalRegexList = externalUnprocessedModules.map(
    m => new RegExp(`node_modules/${m}`),
  );

  return (
    externalRegexList.some(regex => regex.test(p)) ||
    allSourcesButExternalModules(p)
  );
};

module.exports.createBabelConfig = (presetOptions = {}) => {
  const pathsToResolve = [__filename];
  try {
    pathsToResolve.push(require.resolve('yoshi'));
  } catch (e) {}
  return {
    presets: [
      [
        require.resolve('babel-preset-yoshi', {
          paths: pathsToResolve,
        }),
        presetOptions,
      ],
    ],
    babelrc: false,
    configFile: false,
  };
};

module.exports.logIfAny = logIfAny;

module.exports.suffix = suffix => str => {
  const hasSuffix = str.lastIndexOf(suffix) === str.length - suffix.length;
  return hasSuffix ? str : str + suffix;
};

module.exports.reportWebpackStats = (buildType, stats) => {
  console.log(chalk.magenta(`Webpack summary for ${buildType} build:`));
  logIfAny(
    stats.toString({
      colors: true,
      hash: false,
      chunks: false,
      assets: true,
      children: false,
      version: false,
      timings: false,
      modules: false,
      entrypoints: false,
      warningsFilter: /export .* was not found in/,
      builtAt: false,
    }),
  );
};

module.exports.writeFile = (targetFileName, data) => {
  mkdirp.sync(path.dirname(targetFileName));
  fs.writeFileSync(path.resolve(targetFileName), data);
};

module.exports.watch = (
  { pattern, cwd = process.cwd(), ignoreInitial = true, ...options },
  callback,
) => {
  const watcher = chokidar
    .watch(pattern, { cwd, ignoreInitial, ...options })
    .on('all', (event, filePath) => callback(filePath));

  return watcher;
};

module.exports.getMochaReporter = () => {
  if (queries.inTeamCity()) {
    return 'mocha-teamcity-reporter';
  }

  if (process.env.mocha_reporter) {
    return process.env.mocha_reporter;
  }

  return 'progress';
};

module.exports.getListOfEntries = entry => {
  if (typeof entry === 'string') {
    return [path.resolve('src', entry)];
  } else if (typeof entry === 'object') {
    return Object.keys(entry).map(name => {
      const file = entry[name];
      return path.resolve('src', file);
    });
  }
  return [];
};

module.exports.shouldTransformHMRRuntime = () => {
  return project.hmr === 'auto' && project.isReactProject;
};

module.exports.getProcessIdOnPort = port => {
  return childProcess
    .execSync(`lsof -i:${port} -P -t -sTCP:LISTEN`, { encoding: 'utf-8' })
    .split('\n')[0]
    .trim();
};

function getDirectoryOfProcessById(pid) {
  return childProcess
    .execSync(`lsof -p ${pid} | grep cwd | awk '{print $9}'`, {
      encoding: 'utf-8',
    })
    .trim();
}

const getCommandArgByPid = (pid, argIndex = 0) => {
  return childProcess
    .execSync(`ps -p ${pid} | awk '{print $${4 + argIndex}}'`, {
      encoding: 'utf-8',
    })
    .trim();
};

module.exports.processIsJest = pid => {
  const commandArg = getCommandArgByPid(pid, 1);
  return commandArg.split('/').pop() === 'jest';
};

module.exports.getProcessOnPort = async (port, shouldCheckTestResult) => {
  if (shouldCheckTestResult) {
    const portTestResult = await detect(port);

    if (port === portTestResult) {
      return null;
    }
  }
  try {
    const pid = module.exports.getProcessIdOnPort(port);
    const cwd = getDirectoryOfProcessById(pid);

    return {
      pid,
      cwd,
    };
  } catch (e) {
    return null;
  }
};

module.exports.toIdentifier = str => {
  const IDENTIFIER_NAME_REPLACE_REGEX = /^([^a-zA-Z$_])/;
  const IDENTIFIER_ALPHA_NUMERIC_NAME_REPLACE_REGEX = /[^a-zA-Z0-9$]+/g;

  if (typeof str !== 'string') return '';
  return str
    .replace(IDENTIFIER_NAME_REPLACE_REGEX, '_$1')
    .replace(IDENTIFIER_ALPHA_NUMERIC_NAME_REPLACE_REGEX, '_');
};

module.exports.tryRequire = name => {
  let absolutePath;

  try {
    absolutePath = require.resolve(name);
  } catch (e) {
    // The module has not found
    return null;
  }

  return require(absolutePath);
};

/**
 * Gets the artifact id of the project at the current working dir
 */
const getProjectArtifactId = () => {
  if (fs.existsSync(POM_FILE)) {
    const artifactId = new xmldoc.XmlDocument(
      fs.readFileSync(POM_FILE),
    ).valueWithPath('artifactId');

    return artifactId;
  }

  return '';
};

module.exports.getProjectArtifactId = getProjectArtifactId;

const getProjectArtifactVersion = () => {
  return process.env.ARTIFACT_VERSION
    ? // Dev CI
      process.env.ARTIFACT_VERSION.replace('-SNAPSHOT', '')
    : // PR CI won't have a version, only BUILD_NUMBER and BUILD_VCS_NUMBER
      process.env.BUILD_VCS_NUMBER;
};

module.exports.getProjectArtifactVersion = getProjectArtifactVersion;

/**
 * Gets the CDN base path for the project at the current working dir
 */
module.exports.getProjectCDNBasePath = () => {
  const artifactName = getProjectArtifactId();

  let artifactPath = '';

  if (project.experimentalBuildHtml) {
    // Not to be confused with Yoshi's `dist` directory.
    //
    // Static assets are deployed to two locations on the CDN:
    //
    // - `https://static.parastorage.com/services/service-name/dist/asset.f43a1.js`
    // - `https://static.parastorage.com/services/service-name/1.2.3/asset.js`
    //
    // If this experimental feature is enabled, we can benefit from better caching by configuring
    // Webpack's `publicUrl` to use the first option.
    artifactPath = 'dist';
  } else {
    artifactPath = getProjectArtifactVersion();
  }

  return `${staticsDomain}/${artifactName}/${artifactPath}/`;
};

module.exports.killSpawnProcessAndHisChildren = child => {
  return new Promise(resolve => {
    if (!child) {
      return resolve();
    }

    const pid = child.pid;

    psTree(pid, (err, children) => {
      [pid].concat(children.map(p => p.PID)).forEach(tpid => {
        try {
          process.kill(tpid, 'SIGKILL');
        } catch (e) {}
      });

      child = null;
      resolve();
    });
  });
};
