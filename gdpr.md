# Privacy Policy for "LN Filter — LinkedIn Feed Re-Ranker"

**1. Introduction and Data Controller**
We are pleased that you are using our Chrome extension "LN Filter" (hereinafter referred to as the "Extension"). The protection of your personal data is very important to us. This Privacy Policy informs you about the type, scope, and purpose of the collection and use of data when using our Extension.

The Data Controller within the meaning of the General Data Protection Regulation (GDPR) is you, as all operations happen in your browser.

**2. How the Extension Works and Data Processing**
"LN Filter" is an extension that runs locally in your browser to analyze and re-rank your LinkedIn feed. The developer of the Extension operates **no proprietary servers** and collects **no telemetry, tracking, or usage data**.

When you use the Extension, the following data processing occurs directly on your device:

**a) Collection of Website Content (LinkedIn)**
For the Extension to function, it reads the content of the currently visited LinkedIn page. This involves extracting the text and authors of the displayed LinkedIn posts.
*Purpose:* To evaluate and filter the posts according to the user's local settings.
*Storage:* This data is processed transiently. A hash value of the posts (generated from the author and text) is stored locally in your browser's cache (`chrome.storage.local`) to prevent the same post from being evaluated multiple times.

**b) Storage of the API Key and User Settings**
To utilize the artificial intelligence features, you must provide your own API key (Google Gemini API Key).
*Storage:* The API key, as well as your personal interests, dislikes, and category weightings, are stored exclusively locally on your device (`chrome.storage.local`). At no point do we have access to this key or your filter settings.

**c) Data Transmission to Third Parties (Google Gemini API)**
To evaluate the extracted LinkedIn posts, the Extension sends the post texts, author names, and your configured interests directly from your browser via an encrypted connection to Google's servers.
*Purpose:* Analysis and evaluation of the feed posts by the AI model (Gemini).
*Recipient:* Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Ireland (or Google LLC, USA).
*Additional feature "Google Search Grounding":* If you activate this feature in the options, the Google Gemini API will independently perform web searches to assess the recency and factual accuracy of posts.
*Note:* The [Google Privacy Policy](https://policies.google.com/privacy) and Google's API Terms of Service apply to this process.

**3. Data Sharing with Third Parties**
Because the developer of the Extension does not collect or store any personal data, we do not share any data with third parties. The only external communication occurs directly between your browser and the Google servers (see section 2c), as well as LinkedIn.

**4. Your Rights and Control Options**
Since we do not store any of your data on our systems, we cannot provide information about your data or delete it. However, you maintain full local control:

* **Deletion:** You can delete all data stored by the Extension (including the API key and cache) at any time by clearing the extension data in your Chrome settings or by uninstalling the Extension.
* **Revocation:** You can stop the data processing at any time by disabling the Extension.

**5. Changes to this Privacy Policy**
We reserve the right to modify this Privacy Policy to ensure it always complies with current legal requirements or to accurately reflect changes in how the Extension operates.

Last updated: May 2 2026

