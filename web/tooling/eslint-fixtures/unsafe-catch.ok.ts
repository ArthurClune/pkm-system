export function run(p: Promise<number>): void {
  p.then((n) => n).catch((err: unknown) => {
    console.log(err);
  });
}
