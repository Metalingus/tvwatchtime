import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateContactThreadDto, CreateContactMessageDto } from './contact.dto';

describe('Contact DTO validation', () => {
  it('accepts a non-empty body (regression: @Min(1) wrongly rejected strings)', async () => {
    const dto = plainToInstance(CreateContactThreadDto, { reason: 'FEEDBACK', subject: 'hi', body: 'hello' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts a non-empty reply body', async () => {
    const dto = plainToInstance(CreateContactMessageDto, { body: 'a reply' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects an empty body', async () => {
    const dto = plainToInstance(CreateContactMessageDto, { body: '' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an empty subject', async () => {
    const dto = plainToInstance(CreateContactThreadDto, { reason: 'FEEDBACK', subject: '', body: 'x' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
