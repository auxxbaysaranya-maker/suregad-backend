export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function notFound(message = "Resource not found"): AppError {
  return new AppError(404, "NOT_FOUND", message);
}

export function forbidden(message = "You do not have permission to do that."): AppError {
  return new AppError(403, "FORBIDDEN", message);
}

export function unauthenticated(message = "Authentication required."): AppError {
  return new AppError(401, "UNAUTHENTICATED", message);
}
