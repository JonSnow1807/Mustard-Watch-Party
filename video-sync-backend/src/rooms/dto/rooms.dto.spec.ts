import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../validation';
import { CreateRoomDto } from './create-room.dto';
import { UpdateRoomDto } from './update-room.dto';

// The pipe under test is built from the SAME options object main.ts hands
// to useGlobalPipes (validation.ts) - these tests pin production semantics,
// not a copy that could drift.
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

const asCreate = (body: unknown): Promise<CreateRoomDto> =>
  pipe.transform(body, { type: 'body', metatype: CreateRoomDto, data: '' });
const asUpdate = (body: unknown): Promise<UpdateRoomDto> =>
  pipe.transform(body, { type: 'body', metatype: UpdateRoomDto, data: '' });

// No userId: the creator is the bearer token's subject, not a body field.
const base = { name: 'movie night' };

describe('CreateRoomDto through the production pipe', () => {
  it('admits a minimal body and returns a class instance', async () => {
    const dto = await asCreate({ ...base });
    expect(dto).toBeInstanceOf(CreateRoomDto);
    expect(dto.name).toBe('movie night');
  });

  it('admits a full body with an acceptable videoUrl', async () => {
    const dto = await asCreate({
      ...base,
      videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
      isPublic: true,
      description: 'weekly watch party',
      tags: ['scifi', 'weekly'],
      allowGuestControl: true,
    });
    expect(dto.videoUrl).toBe('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  });

  it('admits a bare YouTube id and the empty-string sentinel', async () => {
    await expect(
      asCreate({ ...base, videoUrl: 'aqz-KE-bpKQ' }),
    ).resolves.toBeDefined();
    await expect(asCreate({ ...base, videoUrl: '' })).resolves.toBeDefined();
  });

  it('trims videoUrl and name before validating (transform is load-bearing)', async () => {
    // the shared rule refuses surrounding whitespace, so these pass ONLY
    // if @Transform ran first - this is the test that pins transform:true
    const dto = await asCreate({
      ...base,
      name: '  movie night  ',
      videoUrl: ' https://cdn.example.com/movie.mp4 ',
    });
    expect(dto.name).toBe('movie night');
    expect(dto.videoUrl).toBe('https://cdn.example.com/movie.mp4');
  });

  it('strips unknown properties (whitelist is load-bearing)', async () => {
    const dto = await asCreate({ ...base, isActive: false, maxUsers: 0 });
    expect('isActive' in dto).toBe(false);
    expect('maxUsers' in dto).toBe(false);
  });

  it('strips userId - a CREATE body cannot choose the owner', async () => {
    // creatorId comes from the verified token (JwtAuthGuard), so a userId
    // here is a client assertion with nowhere to land. Stripping (rather
    // than 400) is what lets a not-yet-updated client keep working: it
    // needs a token, not a smaller body.
    const dto = await asCreate({ ...base, userId: 'attacker' });
    expect('userId' in dto).toBe(false);
    expect(dto.name).toBe('movie night');
  });

  it.each([
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,x'],
    ['single-token garbage', 'hello'],
    ['provider host without an id', 'https://www.youtube.com/'],
    ['oversized URL', 'https://a.com/' + 'x'.repeat(2048)],
  ])('refuses videoUrl: %s', async (_name, videoUrl) => {
    await expect(asCreate({ ...base, videoUrl })).rejects.toThrow(
      BadRequestException,
    );
  });

  it.each([
    ['missing name', {}],
    ['empty name', { ...base, name: '' }],
    ['whitespace-only name (empty after trim)', { ...base, name: '   ' }],
    ['non-string tag', { ...base, tags: [42] }],
    // null is NOT absent: @IsOptional would wave these through to Prisma
    // (a 500 on the non-nullable column); SkipIfAbsent makes them a 400
    ['null name', { ...base, name: null }],
    ['null videoUrl (only "" clears)', { ...base, videoUrl: null }],
    ['null isPublic', { ...base, isPublic: null }],
    ['null tags', { ...base, tags: null }],
  ])('refuses %s', async (_name, body) => {
    await expect(asCreate(body)).rejects.toThrow(BadRequestException);
  });
});

describe('UpdateRoomDto through the production pipe', () => {
  it('admits an empty patch and the clear-video sentinel', async () => {
    // the settings form round-trips `room.videoUrl || ''` - a save on a
    // room with no video sends '', and must not 400
    await expect(asUpdate({})).resolves.toBeDefined();
    await expect(asUpdate({ videoUrl: '' })).resolves.toBeDefined();
  });

  it('strips userId - a PATCH body cannot reassign ownership', async () => {
    // the body flows verbatim into Prisma room.update; this stripping is
    // the guard, so its absence must fail the build, not a code review
    const dto = await asUpdate({ videoUrl: 'aqz-KE-bpKQ', userId: 'attacker' });
    expect('userId' in dto).toBe(false);
    expect(dto.videoUrl).toBe('aqz-KE-bpKQ');
  });

  it('refuses a hostile videoUrl and an empty name', async () => {
    await expect(asUpdate({ videoUrl: 'javascript:alert(1)' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(asUpdate({ name: '' })).rejects.toThrow(BadRequestException);
  });

  it('refuses null fields - null is a value, not an absence', async () => {
    // name: null would reach Prisma as a non-nullable column write (500);
    // videoUrl: null would clear the video around the documented '' path
    await expect(asUpdate({ name: null })).rejects.toThrow(BadRequestException);
    await expect(asUpdate({ videoUrl: null })).rejects.toThrow(
      BadRequestException,
    );
  });
});
