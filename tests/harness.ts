type TestFunction = () => void | Promise<void>;

interface TestCase {
  name: string;
  run: TestFunction;
}

const cases: TestCase[] = [];
const suites: string[] = [];

export function describe(name: string, define: () => void): void {
  suites.push(name);
  try {
    define();
  } finally {
    suites.pop();
  }
}

export function it(name: string, run: TestFunction): void {
  cases.push({ name: [...suites, name].join(" > "), run });
}

export async function runRegisteredTests(): Promise<number> {
  let failures = 0;
  for (const testCase of cases) {
    try {
      await testCase.run();
      process.stdout.write(`✓ ${testCase.name}\n`);
    } catch (error) {
      failures += 1;
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`✗ ${testCase.name}\n${detail}\n`);
    }
  }
  process.stdout.write(`\n${cases.length - failures}/${cases.length} tests passed.\n`);
  return failures;
}
