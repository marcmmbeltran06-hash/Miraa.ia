export interface RobotsTxtOptions {
  enabled?: boolean;
  userAgent?: string;
}

interface RobotsRules {
  allow: string[];
  disallow: string[];
}

const DEFAULT_OPTIONS: Required<RobotsTxtOptions> = {
  enabled: false,
  userAgent: '*',
};

export class RobotsTxtManager {
  private readonly enabled: boolean;
  private readonly userAgent: string;
  private readonly cache = new Map<string, RobotsRules>();

  constructor(options: RobotsTxtOptions = {}) {
    this.enabled = options.enabled ?? DEFAULT_OPTIONS.enabled;
    this.userAgent = options.userAgent ?? DEFAULT_OPTIONS.userAgent;
  }

  public async allows(url: string): Promise<boolean> {
    if (!this.enabled) {
      return true;
    }

    try {
      const origin = new URL(url).origin;
      const rules = await this.getRules(origin);
      return this.isPathAllowed(new URL(url).pathname, rules);
    } catch {
      return true;
    }
  }

  private async getRules(origin: string): Promise<RobotsRules> {
    const cached = this.cache.get(origin);
    if (cached) {
      return cached;
    }

    const rules = await this.fetchRules(origin);
    this.cache.set(origin, rules);
    return rules;
  }

  private async fetchRules(origin: string): Promise<RobotsRules> {
    try {
      const response = await fetch(`${origin}/robots.txt`, {
        method: 'GET',
        headers: { 'User-Agent': this.userAgent },
      });

      if (!response.ok) {
        return { allow: [], disallow: [] };
      }

      const content = await response.text();
      return this.parseRobots(content);
    } catch {
      return { allow: [], disallow: [] };
    }
  }

  private parseRobots(content: string): RobotsRules {
    const lines = content.split(/\r?\n/).map((line) => line.trim());
    const rules: RobotsRules = { allow: [], disallow: [] };
    let activeUserAgent = false;

    for (const line of lines) {
      if (!line || line.startsWith('#')) {
        continue;
      }

      const [rawName, rawValue] = line.split(':', 2);
      if (!rawValue) {
        continue;
      }

      const name = rawName.trim().toLowerCase();
      const value = rawValue.trim();

      if (name === 'user-agent') {
        activeUserAgent = value === '*' || value.toLowerCase() === this.userAgent.toLowerCase();
        continue;
      }

      if (!activeUserAgent) {
        continue;
      }

      if (name === 'allow') {
        rules.allow.push(value);
      }

      if (name === 'disallow') {
        rules.disallow.push(value);
      }
    }

    return rules;
  }

  private isPathAllowed(pathname: string, rules: RobotsRules): boolean {
    const allowed = rules.allow.some((pattern) => pathname.startsWith(pattern));
    if (allowed) {
      return true;
    }

    const disallowed = rules.disallow.some((pattern) => pattern !== '' && pathname.startsWith(pattern));
    return !disallowed;
  }
}
