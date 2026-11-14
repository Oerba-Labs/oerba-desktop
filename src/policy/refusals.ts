/* A short record of what the shell refused, for the self-test to read. It keeps the newest `cap` and counts them all,
   so a page that asks a million times costs the app a few kilobytes. */

export class RefusalLog {
  readonly list: string[] = [];
  total = 0;

  constructor(private readonly cap = 200) {}

  push(entry: string): void {
    this.total++;
    this.list.push(entry);
    if (this.list.length > this.cap) this.list.splice(0, this.list.length - this.cap);
  }

  has(part: string): boolean { return this.list.some((e) => e.includes(part)); }
}
