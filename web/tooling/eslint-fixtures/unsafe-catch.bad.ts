// Fixture: @typescript-eslint/use-unknown-in-catch-callback-variable must
// flag the implicitly-`any` caught error in a promise catch callback.
export function run(p: Promise<number>): void {
  p.then((n) => n).catch((err) => {
    console.log(err);
  });
}
