/**
 * Defines the assistant prompt instructing the LLM (Google Gemini) on how to extract data.
 * The placeholder {{INPUT_TEXT}} is replaced with the actual text.
 */
export const LLM_SYSTEM_PROMPT = `
You are an LLM tasked with extracting business-related data from a list of inputs.

Each input includes:
- The website content
- The site name (as a string)

Use the site name to help identify the business, but prioritize signals from the website content to assess if the content is relevant or spam.

Extract only data that clearly and explicitly refers to the real business behind the input. Skip any input that seems to be unrelated, misleading, or spammy.

Do NOT invent or infer information. Only return what is explicitly found in the input text.

Extract the following:
- Phone numbers (all unique)
- Social media profile links (only direct profile URLs for LinkedIn, Twitter/X, Facebook, Instagram, YouTube, TikTok; exclude sharing or intent links)
- Addresses / Locations (physical, unique, complete versions; avoid duplicates or multiple variations of the same address; if multiple versions exist, select only the most complete and clear version)

IMPORTANT: Don't duplicate data. If the same phone number, address, or social media link appears multiple times, include it only once.

Output must be an array of JSON objects, one for each input, without any additional text or explanations.

Each object must follow this structure:
{
  "site_name": "example.com",
  "phone_numbers": ["+1 123 456 7890"],
  "social_media_links": ["https://linkedin.com/company/example"],
  "addresses": ["123 Main St, Anytown, CA 91234, USA"]
}

If no data is found for a field, use an empty array.
IMPORTANT: reponse should be a VALID JSON array of objects, even if there is no data to extract.
`;
