import { SiteProcessingData, ActionStatus, ExtractedData } from './types';

/**
 * Colors and icons for status reporting
 */
export class StatusIcons {
  // Status indicators
  public static readonly SUCCESS = "Success";    // Success
  public static readonly FAILURE = "Failure";    // Failure
  public static readonly PENDING = "Pending";    // Pending
  public static readonly SKIPPED = "Skipped";    // Skipped
  public static readonly PARTIAL = "Partial";    // Partial success
  
  // Console colors
  public static readonly GREEN = "\x1b[32m";     // Green for success
  public static readonly RED = "\x1b[31m";       // Red for failure
  public static readonly YELLOW = "\x1b[33m";    // Yellow for partial/warning
  public static readonly BLUE = "\x1b[34m";      // Blue for info
  public static readonly MAGENTA = "\x1b[35m";   // Magenta for highlights
  public static readonly CYAN = "\x1b[36m";      // Cyan for process steps
  public static readonly RESET = "\x1b[0m";      // Reset color
  public static readonly BOLD = "\x1b[1m";       // Bold text
}

/**
 * Class for generating and displaying status reports
 */
export class StatusReporter {
  /**
   * Format a duration in milliseconds to a human-readable string
   * @param durationMs Duration in milliseconds
   * @returns Formatted duration string
   */
  public formatDuration(durationMs: number): string {
    if (durationMs >= 1000) {
      return `${(durationMs / 1000).toFixed(2)} s`;
    }
    return `${durationMs.toFixed(0)} ms`;
  }

  /**
   * Get the protocol part from a URL
   * @param url The URL to extract protocol from
   * @returns The protocol string (e.g., "HTTP", "HTTPS")
   */
  public getProtocolFromUrl(url: string | undefined): string {
    if (!url) return "Unknown";
    
    try {
      const urlObj = new URL(url);
      return urlObj.protocol.replace(':', '').toUpperCase();
    } catch {
      return url.startsWith('https') ? 'HTTPS' : 
             url.startsWith('http') ? 'HTTP' : 'Unknown';
    }
  }

  /**
   * Create a status object for actions
   * @param success Whether the action was successful
   * @param protocol The protocol used
   * @param details Details about the action
   * @returns Action status object
   */
  public createStatus(
    success: boolean | null, 
    protocol: string = "",
    details: string
  ): ActionStatus {
    let status: string;
    
    if (success === null) {
      status = StatusIcons.SKIPPED;
    } else if (success === true) {
      status = StatusIcons.SUCCESS;
    } else {
      status = StatusIcons.FAILURE;
    }
    
    return { status, protocol, details };
  }

  /**
   * Create a partial success status
   * @param protocol The protocol used
   * @param details Details about the action
   * @returns Action status object
   */
  public createPartialStatus(protocol: string = "", details: string): ActionStatus {
    return { status: StatusIcons.PARTIAL, protocol, details };
  }

  /**
   * Create a pending status
   * @param details Details about the pending action
   * @returns Action status object
   */
  public createPendingStatus(details: string): ActionStatus {
    return { status: StatusIcons.PENDING, protocol: "", details };
  }

  /**
   * Display a summary of site processing
   * @param data The site processing data
   * @param extractedData Optional extracted data from LLM
   */
  public displaySiteProcessingSummary(
    data: SiteProcessingData,
    extractedData?: ExtractedData,
    showDetailedData: boolean = false // New parameter to control detailed data display
  ): void {
    const { siteName, duration, size, actions, contactLinks } = data;
    const c = StatusIcons; // Shorthand for colors
    
    // Title and URL
    console.log(`\n${c.BOLD}${c.MAGENTA}===== SITE PROCESSING: ${siteName} =====${c.RESET}`);
    
    // Start of flowchart
    console.log(`${c.BOLD}${c.BLUE}▶ START [${siteName}]${c.RESET}`);
    
    // Get status information
    const hasLocalSuccess = actions.localGet.status === StatusIcons.SUCCESS;
    const hasExternalSuccess = actions.externalGet.status === StatusIcons.SUCCESS;
    const isLocalHttps = actions.localGet.protocol === "HTTPS";
    const isExternalHttps = actions.externalGet.protocol === "HTTPS";
    const hasContactPages = contactLinks.length > 0;
    
    // --- Download Attempts ---
    // Local HTTPS
    if (hasLocalSuccess && isLocalHttps) {
      console.log(`${c.CYAN}├─ Local GET HTTPS${c.RESET} │ ${c.GREEN}✓ Success${c.RESET}`);
    } else {
      console.log(`${c.CYAN}├─ Local GET HTTPS${c.RESET} │ ${c.RED}✗ Failure${c.RESET}`);
      
      // Local HTTP
      if (hasLocalSuccess && !isLocalHttps) {
        console.log(`${c.CYAN}│  ├─ Local GET HTTP${c.RESET} │ ${c.GREEN}✓ Success${c.RESET}`);
      } else {
        console.log(`${c.CYAN}│  ├─ Local GET HTTP${c.RESET} │ ${c.RED}✗ Failure${c.RESET}`);
        
        // External HTTPS
        if (hasExternalSuccess && isExternalHttps) {
          console.log(`${c.CYAN}│  │  ├─ External GET HTTPS${c.RESET} │ ${c.GREEN}✓ Success${c.RESET}`);
        } else {
          console.log(`${c.CYAN}│  │  ├─ External GET HTTPS${c.RESET} │ ${c.RED}✗ Failure${c.RESET}`);
          
          // External HTTP
          if (hasExternalSuccess && !isExternalHttps) {
            console.log(`${c.CYAN}│  │  │  ├─ External GET HTTP${c.RESET} │ ${c.GREEN}✓ Success${c.RESET}`);
          } else {
            console.log(`${c.CYAN}│  │  │  ├─ External GET HTTP${c.RESET} │ ${c.RED}✗ Failure${c.RESET}`);
            
            // OnlineSearch
            console.log(`${c.CYAN}│  │  │  │  └─ OnlineSearch${c.RESET} │ ${c.YELLOW}● Used${c.RESET}`);
          }
        }
      }
    }
    
    // --- Content ---
    if (hasLocalSuccess || hasExternalSuccess) {
      // Check if SPA
      const isSpaDetected = data.actions.localGet.details?.includes('SPA') || false;
      
      if (isSpaDetected) {
        console.log(`${c.CYAN}│  ├─ Este SPA?${c.RESET} │ ${c.GREEN}✓ Da${c.RESET}`);
        console.log(`${c.CYAN}│  │  └─ Headless Browser${c.RESET} │ ${c.GREEN}✓ Utilizat${c.RESET}`);
        
        // SPA Contact Links
        if (hasContactPages) {
          console.log(`${c.CYAN}│  │     └─ Contact Links SPA?${c.RESET} │ ${c.GREEN}✓ Da${c.RESET} │ ${c.BLUE}${contactLinks.length} pagini descărcate${c.RESET}`);
        } else {
          console.log(`${c.CYAN}│  │     └─ Contact Links SPA?${c.RESET} │ ${c.YELLOW}○ Nu${c.RESET}`);
        }
      } else {
        console.log(`${c.CYAN}│  ├─ Este SPA?${c.RESET} │ ${c.YELLOW}○ Nu${c.RESET}`);
        
        // Standard Contact Links
        if (hasContactPages) {
          console.log(`${c.CYAN}│  │  └─ Contact Links?${c.RESET} │ ${c.GREEN}✓ Da${c.RESET} │ ${c.BLUE}${contactLinks.length} pagini descărcate${c.RESET}`);
        } else {
          console.log(`${c.CYAN}│  │  └─ Contact Links?${c.RESET} │ ${c.YELLOW}○ Nu${c.RESET}`);
        }
      }
    }
    
    // --- Search Augmentation ---
    if (actions.searchAugmentation.status === StatusIcons.SUCCESS) {
      console.log(`${c.CYAN}├─ Search Augmentation${c.RESET} │ ${c.GREEN}✓ Success${c.RESET}`);
    } else if (actions.searchAugmentation.status === StatusIcons.FAILURE) {
      console.log(`${c.CYAN}├─ Search Augmentation${c.RESET} │ ${c.RED}✗ Failure${c.RESET} │ ${actions.searchAugmentation.details}`);
    } else if (actions.searchAugmentation.status === StatusIcons.PENDING) {
      console.log(`${c.CYAN}├─ Search Augmentation${c.RESET} │ ${c.BLUE}⧗ Pending${c.RESET}`);
    } else {
      console.log(`${c.CYAN}├─ Search Augmentation${c.RESET} │ ${c.YELLOW}○ Skipped${c.RESET} │ ${actions.searchAugmentation.details}`);
    }
    
    // --- LLM Processing ---
    if (actions.llmProcessing.status === StatusIcons.SUCCESS) {
      console.log(`${c.CYAN}└─ LLM Processing${c.RESET} │ ${c.GREEN}✓ Success${c.RESET}`);
      
      if (extractedData) {
        const phoneCount = extractedData.phone_numbers[0] !== "nothing found" ? extractedData.phone_numbers.length : 0;
        const socialCount = extractedData.social_media_links[0] !== "nothing found" ? extractedData.social_media_links.length : 0;
        const addressCount = extractedData.addresses[0] !== "nothing found" ? extractedData.addresses.length : 0;
        
        // Show extraction results as a compact table
        console.log(`   ${c.BOLD}Extracted Data:${c.RESET} ${c.BLUE}[${phoneCount}]${c.RESET} Phone Numbers  ${c.BLUE}[${socialCount}]${c.RESET} Social Links  ${c.BLUE}[${addressCount}]${c.RESET} Addresses`);
      }
    } else {
      console.log(`${c.CYAN}└─ LLM Processing${c.RESET} │ ${c.RED}✗ Failure${c.RESET} │ ${actions.llmProcessing.details}`);
    }
    
    // Final stats line
    console.log(`\n${c.BOLD}${c.BLUE}▶ COMPLETE${c.RESET} │ ${c.CYAN}Time: ${this.formatDuration(duration)}${c.RESET} │ ${c.CYAN}Size: ${size !== null ? (size + " bytes") : "N/A"}${c.RESET}`);
    
    // Only display detailed data if requested
    if (showDetailedData) {
      // Display contact links information
      if (contactLinks.length > 0) {
        console.log(`\n${c.BOLD}${c.BLUE}Contact Links (${contactLinks.length}):${c.RESET}`);
        contactLinks.forEach((link, index) => {
          console.log(`  ${index + 1}. ${link}`);
        });
      }
      
      // Display extracted data if available
      if (extractedData) {
        // Only show phone numbers if any were found
        const phones = extractedData.phone_numbers;
        if (phones.length > 0 && phones[0] !== "nothing found") {
          console.log(`\n${c.BOLD}${c.BLUE}Phone Numbers (${phones.length}):${c.RESET}`);
          phones.forEach((phone, index) => {
            console.log(`  ${index + 1}. ${phone}`);
          });
        }
        
        // Only show social media links if any were found
        const socials = extractedData.social_media_links;
        if (socials.length > 0 && socials[0] !== "nothing found") {
          console.log(`\n${c.BOLD}${c.BLUE}Social Media Links (${socials.length}):${c.RESET}`);
          socials.forEach((link, index) => {
            console.log(`  ${index + 1}. ${link}`);
          });
        }
        
        // Only show addresses if any were found
        const addresses = extractedData.addresses;
        if (addresses.length > 0 && addresses[0] !== "nothing found") {
          console.log(`\n${c.BOLD}${c.BLUE}Addresses (${addresses.length}):${c.RESET}`);
          addresses.forEach((address, index) => {
            console.log(`  ${index + 1}. ${address}`);
          });
        }
      }
    }
    
    console.log(`====================================================`);
  }

  /**
   * Display a final summary of all sites processed
   * @param totalSites Total number of sites processed
   * @param successCount Number of successfully processed sites
   * @param errorCount Total number of sites with errors
   * @param downloadErrorCount Number of sites with download errors
   * @param llmErrorCount Number of sites with LLM processing errors
   * @param unexpectedErrorCount Number of sites with unexpected errors
   * @param totalDuration Total duration of processing in milliseconds
   */
  public displayFinalSummary(
    totalSites: number,
    successCount: number,
    errorCount: number,
    downloadErrorCount: number = 0,
    llmErrorCount: number = 0,
    unexpectedErrorCount: number = 0,
    totalDuration: number
  ): void {
    const c = StatusIcons; // Shorthand for colors
    
    console.log("\n--- Final Summary ---");
    console.log(`Total Sites Processed: ${totalSites}`);
    console.log(`Successful: ${c.GREEN}${successCount}${c.RESET}`);
    console.log(`Errors: ${c.RED}${errorCount}${c.RESET}`);
    
    // Display detailed error breakdown
    if (errorCount > 0) {
      console.log(`  - Download Errors: ${c.YELLOW}${downloadErrorCount}${c.RESET} (${(downloadErrorCount / totalSites * 100).toFixed(1)}%)`);
      console.log(`  - LLM Errors: ${c.YELLOW}${llmErrorCount}${c.RESET} (${(llmErrorCount / totalSites * 100).toFixed(1)}%)`);
      console.log(`  - Unexpected Errors: ${c.YELLOW}${unexpectedErrorCount}${c.RESET} (${(unexpectedErrorCount / totalSites * 100).toFixed(1)}%)`);
    }
    
    console.log(`Total Duration: ${this.formatDuration(totalDuration)}`);
    console.log("---------------------");
  }
}
