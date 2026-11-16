import { CallHandler, ExecutionContext, Injectable, NestInterceptor, StreamableFile } from '@nestjs/common';
import { map, Observable } from 'rxjs';

/** Serialisasi BigInt/Decimal → string/number agar JSON aman. */
export function serialize(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') {
    // Prisma Decimal
    if (typeof (value as any).toFixed === 'function' && typeof (value as any).d !== 'undefined') return Number(value.toString());
    if (Buffer.isBuffer(value)) return value;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'passwordHash' || k === 'tokenVersion') continue;
      out[k] = serialize(v);
    }
    return out;
  }
  return value;
}

/** Bentuk respons standar { data, meta, error } (PRD bab 12). */
@Injectable()
export class TransformInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((res) => {
        if (res instanceof StreamableFile || Buffer.isBuffer(res)) return res;
        if (res && typeof res === 'object' && res.__paginated) {
          return { data: serialize(res.data), meta: res.meta, error: null };
        }
        return { data: serialize(res ?? null), meta: null, error: null };
      }),
    );
  }
}
