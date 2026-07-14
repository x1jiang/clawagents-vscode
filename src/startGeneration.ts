/** Invalidates asynchronous startup work after a stop/restart boundary. */
export class StartGeneration {
  private value = 0;

  begin(): number {
    this.value += 1;
    return this.value;
  }

  invalidate(): void {
    this.value += 1;
  }

  assertCurrent(token: number): void {
    if (token !== this.value) {
      throw new Error("Sidecar start was superseded by a stop or restart");
    }
  }
}
