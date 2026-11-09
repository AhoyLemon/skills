// Plain ANSI output, since a skill can't count on installing a colour library.
const useColour = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

const paint = (code: string) => (text: string): string => (useColour ? `\u001b[${code}m${text}\u001b[0m` : text);

export const bold = paint('1');
export const dim = paint('2');
export const red = paint('31');
export const green = paint('32');
export const yellow = paint('33');
export const cyan = paint('36');

export const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

export const err = (line = ''): void => {
  process.stderr.write(`${line}\n`);
};

export const heading = (text: string): void => {
  out();
  out(bold(text));
};

export const okLine = (text: string): void => out(`  ${green('✓')} ${text}`);
export const failLine = (text: string): void => out(`  ${red('✗')} ${text}`);
export const warnLine = (text: string): void => out(`  ${yellow('!')} ${text}`);
export const hintLine = (text: string): void => out(`    ${dim(text)}`);
