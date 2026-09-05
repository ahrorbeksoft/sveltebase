/** Private deterministic test support; never published. */
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function clock(initial = 0) {
  let time = initial;
  return {
    now: () => time,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}
export function ids(prefix = 'test') {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}
export function cookieJar() {
  const values = new Map<
    string,
    { value: string; options: Record<string, unknown> }
  >();
  return {
    get: (name: string) => values.get(name)?.value,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      values.set(name, { value, options });
    },
    delete: (name: string) => {
      values.delete(name);
    },
    values,
  };
}
export const exampleRow = (id: string, owner = 'alice') => ({
  id,
  owner,
  title: `Row ${id}`,
});
