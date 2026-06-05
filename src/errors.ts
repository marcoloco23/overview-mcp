/** Error carrying an HTTP status and optional response body, for clean tool errors. */
export class OverviewError extends Error {
  constructor(
    message: string,
    public status?: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "OverviewError";
  }
}
