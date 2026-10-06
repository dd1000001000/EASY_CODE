const SCAN_CHARS = 32 * 1024;

const CLOUDFLARE_INTERSTITIAL = [
  "/cdn-cgi/challenge-platform/",
  "challenges.cloudflare.com",
  "cf-chl",
  "enable javascript and cookies to continue",
  "performing security verification",
  "verify you are human",
  "checking your browser",
  "checking if the site connection is secure",
];

/** A bot-protection service answered in place of the requested page. Retrying the same URL will not help. */
export class WebChallengeError extends Error {
  constructor(url: string) {
    super(
      `${new URL(url).hostname} returned a bot-protection challenge (such as a CAPTCHA) instead of the page. ` +
        "Do not retry this URL; use another source, or ask the user to open it in a browser.",
    );
    this.name = "WebChallengeError";
  }
}

/**
 * Recognize a challenge page from its HTML, or from a reader's Markdown with a leading
 * `Title:` line. Only high-confidence markers count: an ordinary page served behind
 * Cloudflare, DataDome or PerimeterX still loads their scripts and must not match.
 */
export function isChallengePage(text: string): boolean {
  const sample = text.slice(0, SCAN_CHARS).toLowerCase();
  const waitTitle = /<title>\s*just a moment\.\.\.\s*<\/title>|^title:\s*just a moment\.\.\./mu.test(sample);
  if (waitTitle && CLOUDFLARE_INTERSTITIAL.some((marker) => sample.includes(marker))) return true;
  if (
    /<title>\s*attention required! \| cloudflare\s*<\/title>|^title:\s*attention required! \| cloudflare/mu.test(sample)
  )
    return true;
  // DataDome and PerimeterX insert these only into their block pages.
  return sample.includes("geo.captcha-delivery.com/captcha") || sample.includes('id="px-captcha"');
}
