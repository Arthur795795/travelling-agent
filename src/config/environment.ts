export class MissingEnvironmentVariableError extends Error {
  readonly code = "MISSING_SERVER_ENVIRONMENT";
  readonly variableName: string;

  constructor(variableName: string) {
    super(
      `Required server environment variable ${variableName} is unavailable`,
    );
    this.name = "MissingEnvironmentVariableError";
    this.variableName = variableName;
  }
}

function assertServerOnlyName(name: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name) || name.startsWith("NEXT_PUBLIC_")) {
    throw new TypeError(
      "Server environment variable name is invalid or public",
    );
  }
}

export function requireServerEnvironment(
  name: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  assertServerOnlyName(name);
  const value = environment[name];
  if (!value?.trim()) throw new MissingEnvironmentVariableError(name);
  return value;
}
