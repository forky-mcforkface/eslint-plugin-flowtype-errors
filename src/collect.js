/* @flow */
/**
 * Run Flow and collect errors in JSON format
 *
 * Reference the following links for possible bug fixes and optimizations
 * https://github.com/facebook/nuclide/blob/master/pkg/nuclide-flow-rpc/lib/FlowRoot.js
 * https://github.com/ptmt/tryflow/blob/gh-pages/js/worker.js
 */
import pathModule from 'path';
import childProcess from 'child_process';
import slash from 'slash';

let flowBin;

try {
  if (!process.env.FLOW_BIN) {
    flowBin = require('flow-bin'); // eslint-disable-line global-require
  }
} catch (e) {
  /* eslint-disable */
  console.log();
  console.log('Oops! Something went wrong! :(');
  console.log();
  console.log(
    'eslint-plugin-flowtype-errors could not find the package "flow-bin". This can happen for a couple different reasons.'
  );
  console.log();
  console.log(
    '1. If ESLint is installed globally, then make sure "flow-bin" is also installed globally.'
  );
  console.log();
  console.log(
    '2. If ESLint is installed locally, then it\'s likely that "flow-bin" is not installed correctly. Try reinstalling by running the following:'
  );
  console.log();
  console.log('  npm i -D flow-bin@latest');
  console.log();
  process.exit(1);
  /* eslint-enable */
}

export const FlowSeverity = {
  Error: 'error',
  Warning: 'warning',
};

type Pos = {
  line: number,
  column: number
};

type Loc = {
  start: Pos,
  end: Pos
};

// Adapted from https://github.com/facebook/flow/blob/master/tsrc/flowResult.js
type FlowPos = {
  line: number,
  column: number,
  offset: number
};

type FlowLoc = {
  source: ?string,
  start: FlowPos,
  end: FlowPos,
  type: 'SourceFile' | 'LibFile'
};

type FlowMessage = {
  path: string,
  descr: string,
  type: 'Blame' | 'Comment',
  line: number,
  endline: number,
  loc?: ?FlowLoc
};

type FlowError = {
  message: Array<FlowMessage>,
  level?: string,
  operation?: FlowMessage,
  extra?: Array<{
    message: Array<FlowMessage>
  }>
};

function mainLocOfError(error: FlowError): ?FlowLoc {
  const { operation, message } = error;
  return (operation && operation.loc) || message[0].loc;
}

function fatalError(message) {
  return [
    {
      level: FlowSeverity.Error,
      loc: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      message
    }
  ];
}

function formatSeePath(
  message: FlowMessage,
  root: string,
  flowVersion: string
) {
  return message.loc && message.loc.type === 'LibFile'
    ? `https://github.com/facebook/flow/blob/v${flowVersion}/lib/${pathModule.basename(
        message.path
      )}#L${message.line}`
    : `.${slash(message.path.replace(root, ''))}:${message.line}`;
}

function formatMessage(
  message: FlowMessage,
  extras: FlowMessage[],
  root: string,
  flowVersion: string,
  lineOffset: number
) {
  return message.descr.replace(/ (\[\d+\])/g, (matchedStr, extraDescr) => {
    const extraMessage = extras.find(extra => extra.descr === extraDescr);

    if (extraMessage === undefined) {
      return matchedStr;
    }

    if (extraMessage.path !== message.path) {
      return ` (see ${formatSeePath(extraMessage, root, flowVersion)})`;
    }

    return extraMessage.line === message.line
      ? '' // Avoid adding the "see line" message if it's on the same line
      : ` (see line ${lineOffset + extraMessage.line})`;
  });
}

function getFlowBin() {
  return process.env.FLOW_BIN || flowBin;
}

let didExecute = false;

function onExit(root: string) {
  if (!didExecute) {
    didExecute = true;
    process.on('exit', () =>
      childProcess.spawnSync(getFlowBin(), ['stop', root])
    );
  }
}

function spawnFlow(
  mode: string,
  input: string,
  root: string,
  stopOnExit: boolean,
  filepath: string
): string | boolean {
  if (!input) {
    return true;
  }

  const child = childProcess.spawnSync(
    getFlowBin(),
    [mode, '--json', `--root=${root}`, filepath],
    {
      input,
      encoding: 'utf-8'
    }
  );

  const stdout = child.stdout;

  if (!stdout) {
    // Flow does not support 32 bit OS's at the moment.
    return false;
  }

  if (stopOnExit) {
    onExit(root);
  }

  return stdout.toString();
}

function determineRuleType(description) {
  return description.toLowerCase().includes('missing type annotation')
    ? 'missing-annotation'
    : 'default';
}

export type CollectOutputElement = {
  level: string,
  loc: Loc,
  message: string
};

type CollectOutput = Array<CollectOutputElement>;

export function collect(
  stdin: string,
  root: string,
  stopOnExit: boolean,
  filepath: string,
  programOffset: { line: number, column: number }
): CollectOutput | boolean {
  const stdout = spawnFlow('check-contents', stdin, root, stopOnExit, filepath);

  if (typeof stdout !== 'string') {
    return stdout;
  }

  let json;

  try {
    json = JSON.parse(stdout);
  } catch (e) {
    return fatalError('Flow returned invalid json');
  }

  if (!Array.isArray(json.errors)) {
    return json.exit
      ? fatalError(
          `Flow returned an error: ${json.exit.msg} (code: ${json.exit.code})`
        )
      : fatalError('Flow returned invalid json');
  }

  const fullFilepath = pathModule.resolve(root, filepath);

  // Loop through errors in the file
  const output = json.errors
    // Temporarily hide the 'inconsistent use of library definitions' issue
    .filter((error: FlowError) => {
      const mainLoc = mainLocOfError(error);
      const mainFile = mainLoc && mainLoc.source;
      return (
        mainFile &&
        error.message[0].descr &&
        !error.message[0].descr.includes('inconsistent use of') &&
        pathModule.resolve(root, mainFile) === fullFilepath
      );
    })
    .map((error: FlowError) => {
      const { extra, level, message: [messageObject] } = error;
      let message;

      if (extra !== undefined && extra.length > 0) {
        const extras = extra.map(extraObj => extraObj.message[0]); // Normalize extras
        message = formatMessage(
          messageObject,
          extras,
          root,
          json.flowVersion,
          programOffset.line
        );
      } else {
        message = messageObject.descr;
      }

      const defaultPos = { line: 1, column: 1, offset: 0 };
      const loc = messageObject.loc || { start: defaultPos, end: defaultPos };

      const newLoc = {
        start: {
          line: loc.start.line + programOffset.line,
          column:
            loc.start.line === 0
              ? loc.start.column + programOffset.column
              : loc.start.column,
          offset: loc.start.offset
        },
        end: {
          line: loc.end.line + programOffset.line,
          column:
            loc.end.line === 0
              ? loc.end.column + programOffset.column
              : loc.end.column,
          offset: loc.end.offset
        }
      };

      return {
        ...(process.env.DEBUG_FLOWTYPE_ERRRORS === 'true' ? json : {}),
        type: determineRuleType(message),
        level: level || FlowSeverity.Error,
        message,
        path: messageObject.path,
        start: newLoc.start.line,
        end: newLoc.end.line,
        loc: newLoc
      };
    });

  return output;
}

type CoverageOutput = {
  coveredCount: number,
  uncoveredCount: number
};

export function coverage(
  stdin: string,
  root: string,
  stopOnExit: boolean,
  filepath: string
): CoverageOutput | boolean {
  const stdout = spawnFlow('coverage', stdin, root, stopOnExit, filepath);

  if (typeof stdout !== 'string') {
    return stdout;
  }

  let expressions;

  try {
    expressions = JSON.parse(stdout).expressions;
  } catch (e) {
    return {
      coveredCount: 0,
      uncoveredCount: 0
    };
  }

  return {
    coveredCount: expressions.covered_count,
    uncoveredCount: expressions.uncovered_count
  };
}
