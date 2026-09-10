import crypto from 'node:crypto';
import { config } from '../config.js';

const FORMAT_VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface EncryptionService {
  encrypt(value: string): string;
  decrypt(payload: string): string;
}

function keyFromSecret(secret: string): Buffer {
  const normalized = secret.trim();
  if (/^[0-9a-f]{64}$/i.test(normalized)) {
    return Buffer.from(normalized, 'hex');
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(normalized, 'base64url');
  } catch {
    decoded = Buffer.alloc(0);
  }

  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      'BANKING_DATA_ENCRYPTION_KEY must be a 32-byte hexadecimal or base64url value.'
    );
  }

  return decoded;
}

function encode(value: Buffer): string {
  return value.toString('base64url');
}

function decode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

export function createEncryptionService(
  secret = config.secrets.dataEncryptionKey
): EncryptionService {
  const key = keyFromSecret(secret);

  return {
    encrypt(value: string): string {
      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(value, 'utf8'),
        cipher.final()
      ]);

      return [
        FORMAT_VERSION,
        encode(iv),
        encode(cipher.getAuthTag()),
        encode(ciphertext)
      ].join('.');
    },

    decrypt(payload: string): string {
      const parts = payload.split('.');
      if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
        throw new Error('Invalid encrypted value.');
      }

      try {
        const iv = decode(parts[1]);
        const authTag = decode(parts[2]);
        const ciphertext = decode(parts[3]);
        if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
          throw new Error('Invalid encrypted value.');
        }

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        return Buffer.concat([
          decipher.update(ciphertext),
          decipher.final()
        ]).toString('utf8');
      } catch {
        throw new Error('Invalid encrypted value.');
      }
    }
  };
}

export function encryptSensitiveValue(
  value: string,
  secret = config.secrets.dataEncryptionKey
): string {
  return createEncryptionService(secret).encrypt(value);
}

export function decryptSensitiveValue(
  payload: string,
  secret = config.secrets.dataEncryptionKey
): string {
  return createEncryptionService(secret).decrypt(payload);
}
