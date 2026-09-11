import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { maskIban } from '../services/counterparty.js';
import { buildEpcQrPayload, giroCodePayloadSha256, GiroCodeUnavailableError, renderGiroCodePng } from '../services/girocode.js';
import { createGiroCodeTestAsset, findGiroCodeTestImage, findOwnedGiroCodeTestView } from '../services/girocode-test-assets.js';
import { enqueuePushDelivery } from '../services/push-outbox.js';
import { formatEuroCents } from '../services/weekly-budget.js';
import { mutationIsAllowed, noStore, resolveAuthorizedUser, type SessionResolver } from './route-security.js';

type Payment = { beneficiaryName: string; iban: string; bic: string | null; amountCents: number; remittance: string };

export function createGiroCodeTestRouter({ database, resolveSession, clock = () => new Date() }: { database: DatabaseSync; resolveSession: SessionResolver; clock?: () => Date }): express.Router {
  const router = express.Router();
  router.post('/tools/girocode/preview', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    try {
      const payment = paymentFromRequest(request.body);
      const payload = buildEpcQrPayload(payment);
      const png = await renderGiroCodePng(payload);
      noStore(response);
      response.json({ data: publicPayment(payment, payload, `data:image/png;base64,${png.toString('base64')}`) });
    } catch (error) { sendPaymentError(response, error); }
  });

  router.post('/tools/girocode/notify', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    try {
      const payment = paymentFromRequest(request.body);
      const subscriptionId = positiveId(request.body?.subscription_id);
      if (!subscriptionId || !activeSubscriptionOwnedBy(database, subscriptionId, user.id)) {
        noStore(response); response.status(404).json({ error: 'Active push subscription was not found.' }); return;
      }
      const payload = buildEpcQrPayload(payment);
      const now = clock();
      const asset = createGiroCodeTestAsset(database, {
        yuvomiUserId: user.id, payload, beneficiaryName: payment.beneficiaryName, ibanMasked: maskIban(payment.iban),
        amountCents: payment.amountCents, remittance: payment.remittance, now
      });
      enqueuePushDelivery(database, {
        subscriptionId, recipientYuvomiUserId: user.id,
        idempotencyKey: `girocode-test:${user.id}:${subscriptionId}:${crypto.randomUUID()}`,
        notificationType: 'test',
        payload: {
          title: `GiroCode-Test: ${formatEuroCents(payment.amountCents)} EUR`,
          body: `${payment.beneficiaryName} · ${payment.remittance}`,
          url: `/m/banking?view=girocode-test&token=${asset.browserToken}`,
          tag: `banking-girocode-test-${crypto.randomUUID()}`, image: asset.imagePath
        }, now
      });
      noStore(response); response.json({ data: { queued: true, subscription_id: subscriptionId, expires_at: asset.expiresAt } });
    } catch (error) { sendPaymentError(response, error); }
  });

  router.get('/tools/girocode/view/:token', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read'); if (!user) return;
    try {
      const asset = findOwnedGiroCodeTestView(database, user.id, request.params.token, clock());
      if (!asset) { noStore(response); response.status(404).json({ error: 'GiroCode test asset was not found.' }); return; }
      const png = await renderGiroCodePng(asset.payload);
      noStore(response); response.json({ data: { beneficiary_name: asset.beneficiaryName, iban_masked: asset.ibanMasked, amount_cents: asset.amountCents, currency: asset.currency, remittance: asset.remittance, expires_at: asset.expiresAt, png_data_url: `data:image/png;base64,${png.toString('base64')}` } });
    } catch { noStore(response); response.status(404).json({ error: 'GiroCode test asset was not found.' }); }
  });

  router.get('/push/girocode-test-images/:token', async (request, response) => {
    try {
      const asset = findGiroCodeTestImage(database, request.params.token, clock());
      if (!asset) throw new Error('not found');
      const png = await renderGiroCodePng(asset.payload);
      noStore(response); response.setHeader('X-Content-Type-Options', 'nosniff'); response.type('png').send(png);
    } catch { noStore(response); response.status(404).end(); }
  });
  return router;
}

function paymentFromRequest(value: unknown): Payment {
  const body = value as Record<string, unknown>;
  const amountCents = body?.amount_cents;
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.beneficiary_name !== 'string' || typeof body.iban !== 'string' || typeof body.remittance !== 'string' || typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents < 1 || (body.bic !== null && body.bic !== undefined && typeof body.bic !== 'string')) throw new GiroCodeUnavailableError('GiroCode test input is invalid.');
  return { beneficiaryName: body.beneficiary_name, iban: body.iban, bic: typeof body.bic === 'string' ? body.bic : null, amountCents, remittance: body.remittance };
}
function publicPayment(payment: Payment, payload: string, pngDataUrl: string) { return { beneficiary_name: payment.beneficiaryName.trim().normalize('NFC'), iban_masked: maskIban(payment.iban), amount_cents: payment.amountCents, currency: 'EUR', remittance: payment.remittance.trim().normalize('NFC'), payload_sha256: giroCodePayloadSha256(payload), png_data_url: pngDataUrl }; }
function activeSubscriptionOwnedBy(database: DatabaseSync, id: number, userId: number): boolean { return Boolean(database.prepare("SELECT id FROM banking_push_subscriptions WHERE id = ? AND yuvomi_user_id = ? AND status = 'active'").get(id, userId)); }
function positiveId(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null; }
function sendPaymentError(response: express.Response, error: unknown): void { noStore(response); response.status(error instanceof GiroCodeUnavailableError ? 400 : 500).json({ error: error instanceof Error ? error.message : 'GiroCode test could not be processed.' }); }
