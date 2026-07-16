/**
 * Shared "Open to Work" checker backed by the Apify LinkedIn actor.
 *
 * This logic used to be copy-pasted between the two enrichment scripts
 * (enrich-linkedin-apify.ts and enrich-linkedin-sf.ts). It now lives here so
 * the request handling, response parsing, and retry/backoff behaviour have a
 * single implementation.
 */

import { sleep, backoffDelay, getErrorMessage } from '../utils/async.js';

export interface OpenToWorkResult {
  success: boolean;
  openToWork: boolean | null;
  error?: string;
  /** True when the error is transient and the request is worth retrying. */
  isRetryable?: boolean;
  /** Coarse error code for tracking/metrics. */
  errorCode?: string;
}

export interface RetryOptions {
  /** Number of retries after the first attempt. */
  maxRetries: number;
  /** Delay before the first retry; doubles on each subsequent retry. */
  initialRetryDelayMs: number;
}

const APIFY_ENDPOINT =
  'https://api.apify.com/v2/acts/bestscrapers~linkedin-open-to-work-status/run-sync-get-dataset-items';

/** Determine if an HTTP status code is retryable. */
function isRetryableStatusCode(status: number): boolean {
  return status >= 500 || status === 429;
}

/** Determine if an error message indicates a retryable (transient) error. */
function isRetryableError(error: string | undefined): boolean {
  if (!error) return false;
  return (
    error.includes('timeout') ||
    error.includes('timed out') ||
    error.includes('ETIMEDOUT') ||
    error.includes('ECONNRESET') ||
    error.includes('ECONNREFUSED') ||
    error.includes('HTTP 5') ||
    error.includes('HTTP 429')
  );
}

/**
 * Check if a LinkedIn profile is "Open to Work" using the Apify API
 * (single attempt, no retries).
 */
export async function checkOpenToWorkOnce(
  linkedinUrl: string,
  apiToken: string
): Promise<OpenToWorkResult> {
  try {
    // Pass the token via the Authorization header rather than the query string
    // so it is never captured in request URLs / access logs.
    const response = await fetch(APIFY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        linkedin_url: linkedinUrl,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        openToWork: null,
        error: `HTTP ${response.status}: ${errorText}`,
        isRetryable: isRetryableStatusCode(response.status),
        errorCode: `HTTP_${response.status}`,
      };
    }

    const data = await response.json();

    // Apify returns an array of results
    if (Array.isArray(data) && data.length > 0) {
      const result = data[0];

      // Check for timeout error in response
      if (result.messages && result.messages.includes('timed out')) {
        return {
          success: false,
          openToWork: null,
          error: 'API timeout',
          isRetryable: true,
          errorCode: 'APIFY_TIMEOUT',
        };
      }

      // Handle different response formats
      if (result.data && typeof result.data.open_to_work === 'boolean') {
        return { success: true, openToWork: result.data.open_to_work };
      }
      if (typeof result.open_to_work === 'boolean') {
        return { success: true, openToWork: result.open_to_work };
      }
    }

    // Direct object response
    if (data.data && typeof data.data.open_to_work === 'boolean') {
      return { success: true, openToWork: data.data.open_to_work };
    }

    // Unexpected format - could be an invalid LinkedIn URL
    return {
      success: false,
      openToWork: null,
      error: `Unexpected response format: ${JSON.stringify(data)}`,
      isRetryable: false,
      errorCode: 'INVALID_RESPONSE',
    };
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    const isRetryable = isRetryableError(errorMsg);
    return {
      success: false,
      openToWork: null,
      error: errorMsg,
      isRetryable,
      errorCode: isRetryable ? 'TRANSIENT_ERROR' : 'UNKNOWN_ERROR',
    };
  }
}

/**
 * Check if a LinkedIn profile is "Open to Work" using the Apify API, with
 * retry + exponential backoff for transient (retryable) errors.
 */
export async function checkOpenToWork(
  linkedinUrl: string,
  apiToken: string,
  options: RetryOptions
): Promise<OpenToWorkResult> {
  let lastResult: OpenToWorkResult = {
    success: false,
    openToWork: null,
    error: 'Unknown error',
    isRetryable: false,
    errorCode: 'UNKNOWN_ERROR',
  };

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    if (attempt > 0) {
      const delayMs = backoffDelay(attempt, options.initialRetryDelayMs);
      console.log(`   🔄 Retry ${attempt}/${options.maxRetries} after ${delayMs / 1000}s delay...`);
      await sleep(delayMs);
    }

    lastResult = await checkOpenToWorkOnce(linkedinUrl, apiToken);

    // Success, or a non-retryable failure: return immediately.
    if (lastResult.success || !lastResult.isRetryable) {
      return lastResult;
    }

    if (attempt < options.maxRetries) {
      console.log(`   ⚠ ${lastResult.error} - will retry...`);
    }
  }

  return lastResult;
}
