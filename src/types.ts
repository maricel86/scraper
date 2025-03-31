/**
 * Core types for the site processing system
 */

/**
 * Result of downloading a website
 */
export interface DownloadResult {
  content: string;       // The downloaded content (HTML or Markdown)
  effectiveUrl: string;  // The final URL after redirects
  size: number;          // Size in bytes
  links: string[];       // Array of links found on the page
  isMarkdown: boolean;   // Whether the content is already in markdown format
}

/**
 * Status of a download attempt
 */
export interface DownloadStatus {
  success: boolean;      // Whether the download was successful
  protocol: string;      // Protocol used (HTTP/HTTPS)
  method: string;        // Download method used (Local/External/OnlineSearch)
  details: string;       // Additional details about the attempt
  error?: Error;         // Error object if download failed
}

/**
 * Data extracted by the LLM
 */
export interface ExtractedData {
  phone_numbers: string[];
  social_media_links: string[];
  addresses: string[];
}

/**
 * Action status for reporting
 */
export interface ActionStatus {
  status: string;   // Status icon
  protocol: string; // Protocol used (if applicable)
  details: string;  // Additional details about the action
}

/**
 * Complete site processing data for reporting
 */
export interface SiteProcessingData {
  siteName: string;
  duration: number;
  size: number | null;
  actions: {
    localGet: ActionStatus;
    contactPages: ActionStatus;
    externalGet: ActionStatus;
    searchAugmentation: ActionStatus; // Add new status for search augmentation
    llmProcessing: ActionStatus;
  };
  contactLinks: string[];
}

/**
 * Error types for categorization
 */
export enum ErrorType {
  DOWNLOAD = 'download',   // Failed to download the site
  LLM = 'llm',             // LLM processing failed
  UNEXPECTED = 'unexpected' // Other unexpected errors
}

/**
 * Site processing result
 */
export interface SiteProcessingResult {
  success: boolean;
  data: SiteProcessingData;
  extractedData?: ExtractedData;
  error?: Error;
  errorType?: ErrorType;   // Type of error (if any)
}
