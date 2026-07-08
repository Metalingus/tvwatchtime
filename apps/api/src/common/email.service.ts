import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor(private readonly config: ConfigService) {
    const host = config.get<string>('email.host');
    if (host) {
      this.transporter = nodemailer.createTransport({
        host,
        port: config.get<number>('email.port'),
        secure: config.get<boolean>('email.secure'),
        auth: {
          user: config.get<string>('email.user'),
          pass: config.get<string>('email.pass'),
        },
      });
    }
  }

  get enabled(): boolean {
    return this.transporter !== null;
  }

  async send(to: string, subject: string, html: string): Promise<void> {
    if (!this.transporter) {
      this.logger.warn(`SMTP not configured — email not sent to ${to}: ${subject}`);
      return;
    }
    const from = this.config.get<string>('email.from')!;
    await this.transporter.sendMail({ from, to, subject, html });
    this.logger.log(`Email sent to ${to}: ${subject}`);
  }
}
