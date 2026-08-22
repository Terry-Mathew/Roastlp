# Use one deny-by-default boundary for customer-supplied URLs

Every customer-supplied URL and redirect target must pass the same canonicalization, public-address resolution, and redirect-limit boundary before it reaches ScreenshotOne or a direct network client. Canonical targets retain ASCII/punycode hostnames for display, automatic redirects remain disabled, and callers consume only the validated result; this trades some edge-case reachability for a security rule that cannot silently diverge between integrations.

References: [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) and [Node.js DNS documentation](https://nodejs.org/api/dns.html).
