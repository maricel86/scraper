import got from 'got';
import * as cheerio from 'cheerio';

/**
 * Augments existing content with information found through DuckDuckGo search
 * 
 * @param siteName The name of the site to search for
 * @param existingContent The content that has already been gathered from the site
 * @returns The augmented content (existing + search snippets)
 */
export async function augmentWithSearch(
  siteName: string, 
  existingContent: string
): Promise<string> {
  console.log(`Performing search augmentation for ${siteName}...`);
  
  try {
    // Create search query - search for the site name + "contact"
    const query = encodeURIComponent(`"${siteName}" contact`);
    const searchUrl = `https://duckduckgo.com/html/?q=${query}`;
    
    // Fetch search results
    const response = await got(searchUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36' 
      },
      timeout: { request: 20000 }
    });
    

    
    // Parse the HTML response
    const $ = cheerio.load(response.body);
    
    // Extract search result snippets
    let searchContent = '';
    
    // Target DuckDuckGo's search result elements
    // First, try to find the organic search results
    $('.result__body').each((i, result) => {
      // Get the title, URL, and snippet from each result
      const title = $(result).find('.result__title').text().trim();
      const url = $(result).find('.result__url').text().trim();
      const snippet = $(result).find('.result__snippet').text().trim();
      
      if (title && snippet) {
        searchContent += `\n\n==== DuckDuckGo Search Result ====\n`;
        searchContent += `Title: ${title}\n`;
        if (url) {
          searchContent += `URL: ${url}\n`;
        }
        searchContent += `Snippet: ${snippet}\n`;
      }
    });
    
    // If no results found using specific selectors, try a more generic approach
    if (!searchContent) {
      // Look for any elements that might contain result text
      $('div.result, div.serp__result').each((i, result) => {
        const text = $(result).text().trim();
        if (text && text.length > 50) { // Minimum length to filter out trivial elements
          searchContent += `\n\n==== DuckDuckGo Search Result ====\n${text}\n`;
        }
      });
    }
    
    // If still no results, add a fallback message
    if (!searchContent) {
      searchContent = `\n\n==== Search Augmentation ====\nNo specific results found for ${siteName} through DuckDuckGo search.`;
    } else {
      console.log(`Found search results for ${siteName}.`);
    }
    
    // Combine existing content with search results
    // If there's no existing content, just return the search content
    if (!existingContent || existingContent.trim() === '') {
      return `==== Search Augmentation for ${siteName} ====\n${searchContent}`;
    }
    
    // Otherwise, append search content to existing content
    return `${existingContent}\n\n==== Search Augmentation for ${siteName} ====\n${searchContent}`;
  } catch (error) {
    console.error(`Error in search augmentation: ${error instanceof Error ? error.message : String(error)}`);
    
    // If there's an error, return the original content with a note
    const errorNote = `\n\n==== Search Augmentation Error ====\nFailed to retrieve search results for ${siteName}. Error: ${error instanceof Error ? error.message : String(error)}`;
    return existingContent + errorNote;
  }
}
