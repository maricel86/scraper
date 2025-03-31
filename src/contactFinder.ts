import { DownloadResult } from './types';
import { LocalHttpsStrategy } from './strategies/localHttpsStrategy';
import { LocalHttpStrategy } from './strategies/localHttpStrategy';
import { HeadlessBrowserStrategy } from './strategies/headlessBrowserStrategy';

/**
 * Result of contact page processing
 */
export interface ContactProcessingResult {
  contactLinks: string[];
  contactContent: string;
  successCount: number;
  failureCount: number;
  protocol: string;
}

/**
 * Class responsible for finding and processing contact pages
 */
export class ContactFinder {
  /**
   * Keywords used to identify contact pages
   */
  private static readonly CONTACT_KEYWORDS = ['contact', 'imprint', 'impressum', 'about'];

  /**
   * Find contact links in the list of links
   * @param links List of links found on the page
   * @param mainPageUrl The URL of the main page
   * @returns Array of identified contact links
   */
  public findContactLinks(links: string[], mainPageUrl: string): string[] {
    if (!links || links.length === 0) {
      return [];
    }

    // Filter links that contain contact-related keywords
    return links.filter(link => 
      ContactFinder.CONTACT_KEYWORDS.some(keyword => 
        link.toLowerCase().includes(keyword)
      ) && link !== mainPageUrl
    );
  }

  /**
   * Process contact pages by downloading their content
   * @param contactLinks Array of contact page URLs
   * @param protocol The protocol to use (HTTP/HTTPS)
   * @param isSpa Whether the site is a SPA
   * @returns Promise resolving to the contact processing result
   */
  public async processContactPages(
    contactLinks: string[], 
    protocol: string,
    isSpa: boolean = false
  ): Promise<ContactProcessingResult> {
    if (!contactLinks || contactLinks.length === 0) {
      return {
        contactLinks: [],
        contactContent: '',
        successCount: 0,
        failureCount: 0,
        protocol
      };
    }

    // If it's a SPA, use the headless browser to process contact pages
    if (isSpa) {
      return this.processSpaContactPages(contactLinks, protocol);
    }

    let contactContent = '';
    let successCount = 0;
    let failureCount = 0;
    const processedLinks = new Set<string>();
    
    // Use the appropriate strategy based on the protocol
    const strategy = protocol.toUpperCase() === 'HTTPS' 
      ? new LocalHttpsStrategy() 
      : new LocalHttpStrategy();

    for (const contactLink of contactLinks) {
      if (processedLinks.has(contactLink)) {
        continue;  // Skip already processed links
      }

      try {
        const result: DownloadResult = await strategy.download(contactLink);
        contactContent += `\n\n==== Fetched Content From: ${contactLink} ====\n\n${result.content}`;
        processedLinks.add(contactLink);
        successCount++;
      } catch (error) {
        failureCount++;
        // Continue with other links even if one fails
      }
    }

    return {
      contactLinks,
      contactContent,
      successCount,
      failureCount,
      protocol
    };
  }

  /**
   * Process contact pages using headless browser for SPA
   * @param contactLinks Array of contact page URLs
   * @param protocol The protocol used
   * @returns Promise resolving to the contact processing result
   */
  private async processSpaContactPages(
    contactLinks: string[],
    protocol: string
  ): Promise<ContactProcessingResult> {
    // Use HeadlessBrowserStrategy to process SPA contact pages
    const headlessBrowser = new HeadlessBrowserStrategy();
    const mainPageUrl = ""; // Not used in this implementation
    
    try {
      const result = await headlessBrowser.processContactPages(contactLinks, mainPageUrl);
      
      return {
        contactLinks,
        contactContent: result.content,
        successCount: result.successCount,
        failureCount: result.failureCount,
        protocol
      };
    } catch (error) {
      console.error("Error processing SPA contact pages:", error);
      return {
        contactLinks,
        contactContent: '',
        successCount: 0,
        failureCount: contactLinks.length,
        protocol
      };
    }
  }
}
