import { promises as fsPromises } from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';

import { DownloadResult, SiteProcessingData, SiteProcessingResult, ExtractedData, ErrorType } from './types';
import { DownloadStrategyChain } from './strategies/downloadStrategy';
import { LocalHttpsStrategy } from './strategies/localHttpsStrategy';
import { LocalHttpStrategy } from './strategies/localHttpStrategy';
import { ExternalHttpsStrategy } from './strategies/externalHttpsStrategy';
import { ExternalHttpStrategy } from './strategies/externalHttpStrategy';
import { HeadlessBrowserStrategy } from './strategies/headlessBrowserStrategy';
import { ContactFinder } from './contactFinder';
import { StatusReporter, StatusIcons } from './statusReporter';
import { processWithLLM } from './llmProcessor';
import { augmentWithSearch } from './searchAugmentation';

/**
 * Configuration options for site processing
 */
export interface SiteProcessorConfig {
  outputDir: string;
  outputJsonDir: string;
}

/**
 * Main class for processing a website
 */
export class SiteProcessor {
  private readonly contactFinder: ContactFinder;
  private readonly statusReporter: StatusReporter;
  private readonly downloadChain: DownloadStrategyChain;
  private readonly headlessBrowser: HeadlessBrowserStrategy;
  
  /**
   * Create a new SiteProcessor
   * @param config Configuration options
   */
  constructor(private readonly config: SiteProcessorConfig) {
    this.contactFinder = new ContactFinder();
    this.statusReporter = new StatusReporter();
    this.headlessBrowser = new HeadlessBrowserStrategy();

    // Set up the download strategy chain - External strategies disabled
    // 1. Local HTTPS
    // 2. Local HTTP
    // (External strategies and Search augmentation disabled)
    this.downloadChain = new DownloadStrategyChain()
      .addStrategy(new LocalHttpsStrategy())
      .addStrategy(new LocalHttpStrategy())
      .addStrategy(new ExternalHttpsStrategy())
      // External strategies removed
  }

  /**
   * Process a single site
   * @param originalUrl The URL of the site to process
   * @returns A promise resolving to the site processing result
   */
  public async processSite(originalUrl: string): Promise<SiteProcessingResult> {
    const siteStart = performance.now();
    const siteUrl = this.ensureUrlScheme(originalUrl);
    const siteName = this.getSiteNameForDisplay(originalUrl);
    
    console.log(`Processing site: ${siteName}...`);
    
    // Initialize site processing data
    const siteData: SiteProcessingData = {
      siteName,
      duration: 0, // Will be calculated at the end
      size: null,  // Will be updated when content is available
      actions: {
        localGet: this.statusReporter.createPendingStatus("Attempting to download..."),
        contactPages: this.statusReporter.createStatus(null, "", "Not yet started"),
        externalGet: this.statusReporter.createStatus(null, "", "DISABLED în configurație"),
        searchAugmentation: this.statusReporter.createStatus(null, "", "Not yet started"),
        llmProcessing: this.statusReporter.createStatus(null, "", "Not yet started")
      },
      contactLinks: []
    };
    
    try {
      // --- Stage 1: Main Page Download (Local or External) ---
      let mainContent: string = '';
      let links: string[] = [];
      let mainSize: number = 0;
      let effectiveUrl: string = siteUrl;
      let downloadMethod: 'local' | 'external' | 'search' = 'local';
      let processContactsAsSpa: boolean = false; // Flag to track if contact pages should be processed as SPA
      let downloadSuccess = false;

      try {
        // Use the download chain to try all strategies
        const { result, status } = await this.downloadChain.execute(siteUrl, (strategy, attemptStatus) => {
          // Update status based on the method
          if (strategy.method === 'Local') {
            siteData.actions.localGet = {
              status: attemptStatus.success ? StatusIcons.SUCCESS : StatusIcons.FAILURE,
              protocol: attemptStatus.protocol,
              details: attemptStatus.details
            };
          } else if (strategy.method === 'External') {
            siteData.actions.externalGet = {
              status: attemptStatus.success ? StatusIcons.SUCCESS : StatusIcons.FAILURE,
              protocol: attemptStatus.protocol,
              details: attemptStatus.details
            };
          }
        });
        
        downloadSuccess = true;
        
        // Get initial content from the download strategy
        mainContent = result.content;
        links = result.links;
        mainSize = result.size;
        effectiveUrl = result.effectiveUrl;
        
        // Check if the site is an SPA based on content size (less than 1500 bytes)
        const initialIsSpa = mainSize < 1500;
          
        if (initialIsSpa) {
          // Mark that we should process contact pages as SPA too
          processContactsAsSpa = true;
          
          console.log(`Detected SPA for ${siteUrl}, using headless browser...`);
          
          // Update status to reflect SPA detection
          siteData.actions.localGet = {
            ...siteData.actions.localGet,
            details: siteData.actions.localGet.details + " (SPA detected)"
          };
          
          try {
            // Use headless browser to get enriched content
            const headlessResult = await this.headlessBrowser.download(effectiveUrl);
            
            // Update content with headless browser results
            mainContent = headlessResult.content;
            links = headlessResult.links;
            mainSize = headlessResult.size;
            effectiveUrl = headlessResult.effectiveUrl;
            
            console.log(`Successfully processed SPA with headless browser`);
          } catch (headlessError) {
            console.error(`Failed to process SPA with headless browser: ${headlessError instanceof Error ? headlessError.message : String(headlessError)}`);
            // Continue with the original content if headless fails
          }
        }
        
        // Now determine the download method based on the final content
        downloadMethod = links.length > 0 ? 'local' : 
                        (effectiveUrl.includes('jina.ai') ? 'external' : 'search');
        
        console.log(`Download method: ${downloadMethod}`);

        // Update appropriate status
        if (downloadMethod === 'local') {
          // Local download successful - mark external as skipped
          siteData.actions.externalGet = this.statusReporter.createStatus(null, "", "Not needed (local download successful)");
          console.log("Download successful");
        }
        
        // Set site size
        siteData.size = mainSize;
      } catch (downloadError: any) {
        console.log(`Error downloading ${siteName}: ${downloadError.message}`);
        
        // Even though all download methods failed, we'll continue and try search augmentation
        downloadSuccess = false;
        
        // Update status to reflect download failure
        siteData.actions.localGet = {
          status: StatusIcons.FAILURE,
          protocol: '',
          details: `All download attempts failed: ${downloadError.message}`
        };
        
        // Set default values for failed download
        mainContent = '';
        links = [];
        mainSize = 0;
      }
      
      // --- Stage 2: Contact Pages Processing ---
      let contactContent = '';
      
      if (downloadMethod === 'local' && links.length > 0) {
        // Find contact links
        const contactLinks = this.contactFinder.findContactLinks(links, effectiveUrl);
        siteData.contactLinks = contactLinks;
        
        if (contactLinks.length > 0) {
          siteData.actions.contactPages = this.statusReporter.createPendingStatus(
            `Found ${contactLinks.length} contact pages to download`
          );
          
          // Download contact pages - use the processContactsAsSpa flag instead of re-checking mainSize
          const protocol = this.statusReporter.getProtocolFromUrl(effectiveUrl);
          const contactResult = await this.contactFinder.processContactPages(contactLinks, protocol, processContactsAsSpa);
          contactContent = contactResult.contactContent;
          
          // Update contact pages status
          if (contactResult.successCount > 0 && contactResult.failureCount > 0) {
            siteData.actions.contactPages = this.statusReporter.createPartialStatus(
              protocol,
              `Downloaded ${contactResult.successCount}/${contactResult.successCount + contactResult.failureCount} pages`
            );
          } else if (contactResult.successCount > 0) {
            siteData.actions.contactPages = this.statusReporter.createStatus(
              true,
              protocol,
              `Successfully downloaded ${contactResult.successCount} contact page${contactResult.successCount > 1 ? 's' : ''}`
            );
          } else {
            siteData.actions.contactPages = this.statusReporter.createStatus(
              false,
              "",
              `Failed to download any of the ${contactResult.failureCount} contact pages`
            );
          }
        } else {
          siteData.actions.contactPages = this.statusReporter.createStatus(
            null,
            "",
            "No contact pages found in main page links"
          );
        }
      } else if (downloadMethod === 'external') {
        // External method doesn't provide links
        siteData.actions.contactPages = this.statusReporter.createStatus(
          null,
          "",
          "Skipped (external download doesn't extract links)"
        );
      } else {
        // Search method or no links found
        siteData.actions.contactPages = this.statusReporter.createStatus(
          null,
          "",
          "Skipped (no links available)"
        );
      }
      
      // --- Stage 3: Search Augmentation (Disabled) ---
      // Combine main content and contact content
      let combinedContent = mainContent + contactContent;
      
      // Search augmentation is disabled
      siteData.actions.searchAugmentation = this.statusReporter.createStatus(
        null,
        "",
        "DISABLED în configurație"
      );
      console.log(`Search augmentation is disabled for ${siteName}.`);
      
      // --- Stage 4: LLM Processing ---
      const finalContent = combinedContent;
      const finalSize = Buffer.byteLength(finalContent, 'utf8');
      siteData.size = finalSize;
      
      // Skip LLM processing if download failed
      if (!downloadSuccess) {
        console.log(`Download failed for ${siteName}, skipping LLM processing.`);
        
        // Create empty ExtractedData object
        const emptyExtractedData: ExtractedData = {
          phone_numbers: [],
          social_media_links: [],
          addresses: []
        };
        
        // Mark LLM processing as skipped
        siteData.actions.llmProcessing = this.statusReporter.createStatus(
          null,
          "",
          "Skipped (download failed)"
        );
        
        // Save empty JSON result
        const sanitizedHostname = this.getSanitizedHostname(originalUrl, effectiveUrl);
        const jsonFilePath = path.join(this.config.outputJsonDir, sanitizedHostname + ".json");
        await fsPromises.writeFile(
          jsonFilePath,
          JSON.stringify(emptyExtractedData, null, 2),
          'utf-8'
        );
        
        // Calculate final duration
        const siteTotalDuration = performance.now() - siteStart;
        siteData.duration = siteTotalDuration;
        
        // Display results
        this.statusReporter.displaySiteProcessingSummary(siteData, emptyExtractedData, false);
        
        return {
          success: true,
          data: siteData,
          extractedData: emptyExtractedData,
          errorType: ErrorType.DOWNLOAD  // Mark as download error even though success is true
        };
      }
      
      // Continue with LLM processing only if download was successful
      siteData.actions.llmProcessing = this.statusReporter.createPendingStatus("Processing content with LLM...");
      
      try {
        const sanitizedHostname = this.getSanitizedHostname(originalUrl, effectiveUrl);
        
        // Save content to file
        const txtFilePath = path.join(this.config.outputDir, sanitizedHostname + ".txt");
        await fsPromises.writeFile(txtFilePath, finalContent, 'utf-8');
        
        // Process with LLM
        const extractedData: ExtractedData = await processWithLLM(finalContent, originalUrl);
        
        // Count actual found data items
        const dataFound = Object.values(extractedData).filter(arr => 
          arr.length > 0 && arr[0] !== "nothing found").length;
        
        siteData.actions.llmProcessing = this.statusReporter.createStatus(
          true,
          "",
          `Successfully extracted ${dataFound} data categories`
        );
        
        // Save JSON result
        const jsonFilePath = path.join(this.config.outputJsonDir, sanitizedHostname + ".json");
        await fsPromises.writeFile(
          jsonFilePath,
          JSON.stringify(extractedData, null, 2),
          'utf-8'
        );
        
        // Calculate final duration
        const siteTotalDuration = performance.now() - siteStart;
        siteData.duration = siteTotalDuration;
        
        // Display results (compact mode - don't show detailed data)
        this.statusReporter.displaySiteProcessingSummary(siteData, extractedData, false);
        
        return {
          success: true,
          data: siteData,
          extractedData
        };
      } catch (llmError: any) {
        siteData.actions.llmProcessing = this.statusReporter.createStatus(
          false,
          "",
          `Error: ${llmError.message.split('.')[0]}`
        );
        
        // Calculate final duration
        const siteTotalDuration = performance.now() - siteStart;
        siteData.duration = siteTotalDuration;
        
        // Display results even if LLM processing failed
        this.statusReporter.displaySiteProcessingSummary(siteData);
        
        return {
          success: false,
          data: siteData,
          error: llmError,
          errorType: ErrorType.LLM // Mark as LLM error
        };
      }
    } catch (unexpectedError: any) {
      console.error(`Unexpected error processing ${siteName}: ${unexpectedError.message}`);
      
      // Calculate final duration
      const siteTotalDuration = performance.now() - siteStart;
      
      return {
        success: false,
        data: {
          ...siteData,
          duration: siteTotalDuration
        },
        error: unexpectedError,
        errorType: ErrorType.UNEXPECTED // Mark as unexpected error
      };
    }
  }
  
  // --- Helper Methods ---
  
  /**
   * Ensure URL has a scheme (http:// or https://)
   * @param url The URL to check
   * @returns URL with scheme
   */
  private ensureUrlScheme(url: string): string {
    let s = url.trim();
    if (s.endsWith('.')) s = s.slice(0, -1);
    if (!s.startsWith('http://') && !s.startsWith('https://')) {
      s = 'https://' + s;
    }
    return s;
  }
  
  /**
   * Get a display name for a site
   * @param url The site URL
   * @returns Display name
   */
  private getSiteNameForDisplay(url: string): string {
    try {
      const urlObj = new URL(this.ensureUrlScheme(url));
      const hostname = urlObj?.hostname ?? '';
      return hostname.replace(/^www\./, '');
    } catch {
      const fallbackName = url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] ?? url;
      return fallbackName;
    }
  }
  
  /**
   * Get a sanitized hostname for file naming
   * @param url Original URL
   * @param effectiveUrl Effective URL after redirects
   * @returns Sanitized hostname
   */
  private getSanitizedHostname(url: string, effectiveUrl: string): string {
    let hostname = 'unknown_host';
    try {
      // Make sure we have a valid URL with protocol
      const fullUrl = (effectiveUrl || url).startsWith('http') 
        ? (effectiveUrl || url) 
        : `https://${effectiveUrl || url}`;
        
      hostname = new URL(fullUrl).hostname;
    } catch (e) {
      // Fallback: use the URL string but sanitize it
      hostname = url.replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 100);
    }
    
    // Ensure hostname doesn't have invalid characters for filenames
    return hostname.replace(/[^a-zA-Z0-9.-]/g, '_');
  }
}
