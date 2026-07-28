import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ReportView {
  openedAt: string;
  ipHash: string;
  userAgent: string;
}

export interface ReportShare {
  token: string;
  jobId: string;
  recipient: string;
  createdAt: string;
  views: ReportView[];
}

export class ReportShareStore {
  private readonly filePath: string;
  private shares = new Map<string, ReportShare>();

  constructor(filePath = path.join('auditoria', 'report-shares.json')) {
    this.filePath = filePath;
    this.load();
  }

  create(jobId: string, recipient: string): ReportShare {
    const share: ReportShare = {
      token: randomBytes(24).toString('base64url'),
      jobId,
      recipient: recipient.trim() || 'Destinatario',
      createdAt: new Date().toISOString(),
      views: [],
    };
    this.shares.set(share.token, share);
    this.persist();
    return share;
  }

  get(token: string): ReportShare | undefined {
    return this.shares.get(token);
  }

  recordView(token: string, ip: string, userAgent: string): ReportShare | undefined {
    const share = this.shares.get(token);
    if (!share) return undefined;
    share.views.push({
      openedAt: new Date().toISOString(),
      ipHash: createHash('sha256').update(ip).digest('hex').slice(0, 16),
      userAgent: userAgent.slice(0, 240),
    });
    this.persist();
    return share;
  }

  private load(): void {
    try {
      const entries = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as ReportShare[];
      this.shares = new Map(entries.map((share) => [share.token, share]));
    } catch {
      this.shares = new Map();
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify([...this.shares.values()], null, 2), 'utf8');
    fs.renameSync(temporary, this.filePath);
  }
}
