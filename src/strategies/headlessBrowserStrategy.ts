import { BaseDownloadStrategy } from './downloadStrategy';
import { DownloadResult } from '../types';
import * as puppeteer from 'puppeteer';
import TurndownService from 'turndown';
import * as cheerio from 'cheerio';

/**
 * Strategy for downloading using Headless Browser (Puppeteer)
 * Used for processing SPA sites where static HTML does not contain full content
 */
export class HeadlessBrowserStrategy extends BaseDownloadStrategy {
  constructor() {
    super('Headless Browser', 'HTTPS', 'Local');
  }
  
  /**
   * Download content using a headless browser
   * @param url The URL to download
   * @returns A promise resolving to the download result
   */
  async download(url: string): Promise<DownloadResult> {
    console.log(`Using headless browser to process SPA: ${url}`);
    
    let browser;
    try {
      // Launch browser with minimal settings for better compatibility
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox', 
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu'
        ],
        timeout: 30000
      });
      
      const page = await browser.newPage();
      
      // Set a realistic user agent
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36');
      
      // Configure timeouts and navigation
      await page.setDefaultNavigationTimeout(30000);
      await page.setDefaultTimeout(30000);
      
      // Intercept and block unnecessary resources to improve performance
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const resourceType = request.resourceType();
        if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
          request.abort();
        } else {
          request.continue();
        }
      });
      
      // Navigate to URL with proper wait conditions
      await page.goto(url, { 
        waitUntil: ['domcontentloaded', 'networkidle2'], 
        timeout: 30000 
      });
      
      // Wait dynamically for content to load
      await this.waitForPageContent(page);
      
      // Extract the current URL (after any redirects)
      const effectiveUrl = page.url();
      
      // Extract all links from the page
      const links = await this.extractLinks(page, effectiveUrl);
      
      // Get the page content
      const html = await page.content();
      
      // Process the HTML content
      const processedHtml = this.processHtml(html);
      
      // Convert HTML to markdown
      const markdown = this.htmlToMarkdown(processedHtml, effectiveUrl);
      const size = Buffer.byteLength(markdown, 'utf8');
      
      // Filter and deduplicate links
      const uniqueLinks = [...new Set(links)];
      
      return {
        content: markdown,
        effectiveUrl,
        size,
        links: uniqueLinks,
        isMarkdown: true
      };
    } catch (error) {
      console.error(`Headless browser error: ${error instanceof Error ? error.message : String(error)}`);
      throw new Error(`Failed to process SPA with headless browser: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }
  
  /**
   * Wait for page content to load dynamically
   * @param page Puppeteer page object
   */
  private async waitForPageContent(page: puppeteer.Page): Promise<void> {
    // Wait for initial render
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Dynamic wait based on network activity and DOM changes
    const maxWaitTime = 5000; // Maximum wait time in ms
    const startTime = Date.now();
    
    let previousDocumentLength = 0;
    let stableCount = 0;
    
    while (Date.now() - startTime < maxWaitTime) {
      const docLength = await page.evaluate(() => document.documentElement.outerHTML.length);
      
      // Check if document length has stabilized
      if (Math.abs(docLength - previousDocumentLength) < 50) {
        stableCount++;
        if (stableCount >= 3) {
          break; // Content has stabilized
        }
      } else {
        stableCount = 0; // Reset counter if document is still changing
      }
      
      previousDocumentLength = docLength;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  /**
   * Extract links from the page
   * @param page Puppeteer page object
   * @param baseUrl Base URL for resolving relative links
   * @returns Array of extracted links
   */
  private async extractLinks(page: puppeteer.Page, baseUrl: string): Promise<string[]> {
    return await page.evaluate((baseUrl) => {
      // Get all link elements
      const linkElements = document.querySelectorAll('a[href]');
      const links: string[] = [];
      
      // Process each link
      linkElements.forEach((element) => {
        const href = element.getAttribute('href');
        
        // Filter out invalid links
        if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) {
          return;
        }
        
        // Resolve relative URLs
        try {
          const absoluteUrl = new URL(href, baseUrl).href;
          links.push(absoluteUrl);
        } catch (error) {
          // Skip invalid URLs
        }
      });
      
      return links;
    }, baseUrl);
  }
  
  /**
   * Process HTML content using Cheerio
   * @param html Raw HTML content
   * @returns Processed HTML content
   */
  private processHtml(html: string): string {
    const $ = cheerio.load(html);
    
    // Remove unwanted elements
    $('script, style, link[rel="stylesheet"], noscript, iframe, svg').remove();
    
    // Clean up attributes that might interfere with content extraction
    $('[style*="display:none"], [style*="display: none"], [hidden], [aria-hidden="true"]').remove();
    
    // Find main content using the Readability-inspired approach
    const mainContent = this.findMainContent($);
    
    return mainContent || $('body').html() || '';
  }
  
  /**
   * Find the main content section using a Readability-inspired algorithm
   * @param $ Cheerio instance
   * @returns HTML of the main content section
   */
  private findMainContent($: cheerio.CheerioAPI): string | null {
    // Initialize candidate scores
    const candidates: { element: cheerio.Cheerio<any>; score: number; }[] = [];
    
    // Score content containers
    $('div, section, article, main, .content, #content, .post, .article, .page-content, .entry-content').each((_, element) => {
      const $element = $(element);
      let score = 0;
      
      // Text length score
      const text = $element.text().trim();
      score += Math.min(Math.floor(text.length / 100), 20);
      
      // Paragraph density score
      const paragraphs = $element.find('p').length;
      score += paragraphs * 2;
      
      // Heading score
      score += $element.find('h1, h2, h3, h4, h5, h6').length * 3;
      
      // Image score (content often has relevant images)
      score += $element.find('img').length;
      
      // List score (content often has lists)
      score += $element.find('ul, ol').length * 2;
      
      // Class/ID score - positive indicators
      const classAndId = ($element.attr('class') || '') + ' ' + ($element.attr('id') || '');
      const positiveRegex = /content|article|post|entry|text|body|column|main|page/i;
      if (positiveRegex.test(classAndId)) score += 5;
      
      // Class/ID score - negative indicators
      const negativeRegex = /comment|meta|footer|footnote|sidebar|widget|banner|ad|promo|navigation|nav|menu/i;
      if (negativeRegex.test(classAndId)) score -= 10;
      
      // Avoid nested high-scoring containers to prevent duplication
      let parent = $element.parent();
      let isNested = false;
      for (let i = 0; i < 3 && parent.length; i++) {
        if (positiveRegex.test((parent.attr('class') || '') + ' ' + (parent.attr('id') || ''))) {
          isNested = true;
          break;
        }
        parent = parent.parent();
      }
      
      // Add to candidates if score is positive and has sufficient content
      if (score > 10 && text.length > 200 && !isNested) {
        candidates.push({ element: $element, score });
      }
    });
    
    // Sort by score and get the highest
    candidates.sort((a, b) => b.score - a.score);
    
    // TypeScript safety: Use conditional to ensure we have candidates
    if (candidates.length > 0) {
      // Use non-null assertion to tell TypeScript we're sure this exists
      const topCandidate = candidates[0]!;
      if (topCandidate.score > 20) {
        const html = topCandidate.element.html();
        return html !== undefined ? html : null;
      }
    }
    
    return null;
  }
  
  /**
   * Convert HTML to markdown with enhanced formatting preservation
   * @param html The HTML content to convert
   * @param baseUrl The base URL for resolving relative links
   * @returns The converted markdown content
   */
  private htmlToMarkdown(html: string, baseUrl: string): string {
    // Clean up the HTML further before conversion
    const $ = cheerio.load(html);
    
    // Preserve line breaks
    $('br').replaceWith('\n');
    
    // Add spacing around headings and paragraphs
    $('h1, h2, h3, h4, h5, h6, p').each((_, el) => {
      $(el).before('\n\n').after('\n\n');
    });
    
    // Replace complicated tables with simplified versions
    $('table').each((_, table) => {
      const $table = $(table);
      const headers: string[] = [];
      const rows: string[][] = [];
      
      // Extract headers
      $table.find('th').each((_, th) => {
        headers.push($(th).text().trim());
      });
      
      // Extract rows
      $table.find('tbody > tr').each((_, tr) => {
        const rowData: string[] = [];
        $(tr).find('td').each((_, td) => {
          rowData.push($(td).text().trim());
        });
        if (rowData.length > 0) {
          rows.push(rowData);
        }
      });
      
      // Create simplified table markup
      let tableMarkup = '';
      if (headers.length > 0) {
        tableMarkup += `<div class="table-header">${headers.join(' | ')}</div>\n`;
      }
      
      rows.forEach(row => {
        tableMarkup += `<div class="table-row">${row.join(' | ')}</div>\n`;
      });
      
      $table.replaceWith(tableMarkup);
    });
    
    const turndownService = new TurndownService({ 
      headingStyle: 'atx', 
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '_'
    });
    
    // Add custom rules for better formatting
    turndownService.addRule('emphasis', {
      filter: ['em', 'i'],
      replacement: (content) => `_${content}_`
    });
    
    turndownService.addRule('strong', {
      filter: ['strong', 'b'],
      replacement: (content) => `**${content}**`
    });
    
    // Enhanced link handling
    turndownService.addRule('links', {
      filter: 'a',
      replacement: (content, node) => {
        const href = (node as any).getAttribute('href');
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
          return content;
        }
        
        let absoluteUrl;
        try {
          absoluteUrl = new URL(href || '', baseUrl).href;
        } catch {
          absoluteUrl = href || '';
        }
        
        return `[${content}](${absoluteUrl})`;
      }
    });
    
    // Convert HTML to markdown
    return turndownService.turndown($.html());
  }
  
  /**
   * Process contact pages with enhanced error handling and content extraction
   * @param contactLinks Array of contact page URLs
   * @param mainPageUrl The main page URL
   * @returns Promise resolving to combined contact page content
   */
  public async processContactPages(
    contactLinks: string[], 
    mainPageUrl: string
  ): Promise<{ content: string; successCount: number; failureCount: number }> {
    if (!contactLinks || contactLinks.length === 0) {
      return {
        content: '',
        successCount: 0,
        failureCount: 0
      };
    }
    
    let combinedContent = '';
    let successCount = 0;
    let failureCount = 0;
    const processedLinks = new Set<string>();
    
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox', 
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu'
        ],
        timeout: 30000
      });
      
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36');
      
      // Configure request interception for performance
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const resourceType = request.resourceType();
        if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
          request.abort();
        } else {
          request.continue();
        }
      });
      
      for (const contactLink of contactLinks) {
        if (processedLinks.has(contactLink)) {
          continue;  // Skip already processed links
        }
        
        try {
          // Navigate with appropriate wait conditions
          await page.goto(contactLink, { 
            waitUntil: ['domcontentloaded', 'networkidle2'], 
            timeout: 15000 
          });
          
          // Wait for content to stabilize
          await this.waitForPageContent(page);
          
          // Get the page content
          const html = await page.content();
          
          // Process the HTML content
          const processedHtml = this.processHtml(html);
          
          // Convert to markdown
          const markdown = this.htmlToMarkdown(processedHtml, contactLink);
          
          combinedContent += `\n\n==== Fetched Content From: ${contactLink} ====\n\n${markdown}`;
          processedLinks.add(contactLink);
          successCount++;
        } catch (error) {
          console.error(`Failed to process contact page ${contactLink}: ${error instanceof Error ? error.message : String(error)}`);
          failureCount++;
          // Continue with other links even if one fails
        }
      }
    } catch (error) {
      console.error(`Error in headless browser contact processing: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (browser) {
        await browser.close();
      }
    }
    
    return {
      content: combinedContent,
      successCount,
      failureCount
    };
  }
}