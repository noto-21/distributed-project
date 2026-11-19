class AppError extends Error {
  /**
   * @param {string} message - Human-readable error description
   * @param {number} statusCode - HTTP status code (e.g., 400, 404, 409, 503)
   * @param {string} [errorCode='INTERNAL_ERROR'] - Machine-readable error identifier
   * @param {Object} [details=null] - Optional structured validation or distributed context
   */
  constructor(message, statusCode = 500, errorCode = "INTERNAL_ERROR", details = null) {
    super(message);

    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith("4") ? "fail" : "error";
    this.errorCode = errorCode;
    this.details = details;
    this.branch = process.env.BRANCH_NAME || "unknown";
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message, errorCode = "BAD_REQUEST", details = null) {
    return new AppError(message, 400, errorCode, details);
  }

  static unauthorized(message = "Authentication required", errorCode = "UNAUTHORIZED") {
    return new AppError(message, 401, errorCode);
  }

  static forbidden(message = "Access denied", errorCode = "FORBIDDEN") {
    return new AppError(message, 403, errorCode);
  }

  static notFound(message = "Resource not found", errorCode = "NOT_FOUND") {
    return new AppError(message, 404, errorCode);
  }

  static conflict(message, errorCode = "CONFLICT", details = null) {
    return new AppError(message, 409, errorCode, details);
  }

  static serviceUnavailable(
    message = "Peer branch unreachable",
    errorCode = "PEER_UNAVAILABLE",
    details = null,
  ) {
    return new AppError(message, 503, errorCode, details);
  }
}

module.exports = AppError;
