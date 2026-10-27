/**
 * Analytics stubbed out for privacy-first / decluttered build.
 * All tracking calls are no-ops.
 */

export const initAnalytics = async () => {
  // no-op
};

export const trackAppEvent = async (_name: string, _props?: Record<string, any>) => {
  // no-op
};

export const trackAppError = async (_err: unknown, _context?: Record<string, any>) => {
  // no-op
};
