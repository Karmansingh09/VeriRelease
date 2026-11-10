/**
 * VeriRelease Webhook Delivery Repository Interface
 *
 * Defines persistence and deduplication operations for GitHub webhook deliveries.
 */

import type { PrismaTransactionClient } from "../../../lib/prisma";
import type { GitHubDeliveryStatus, GitHubWebhookDelivery } from "../types";

export interface CreateWebhookDeliveryInput {
  id?: string;
  deliveryId: string;
  eventType: string;
  action?: string | null;
  status?: GitHubDeliveryStatus;
  repositoryId?: bigint | null;
  payload: Record<string, unknown>;
  payloadHash: string;
  errorMessage?: string | null;
}

export interface WebhookDeliveryOptions {
  tx?: PrismaTransactionClient;
}

export interface WebhookDeliveryRepository {
  /**
   * Persists a newly received webhook delivery record.
   */
  create(
    input: CreateWebhookDeliveryInput,
    options?: WebhookDeliveryOptions
  ): Promise<GitHubWebhookDelivery>;

  /**
   * Safely attempts to insert a delivery record using ON CONFLICT DO NOTHING,
   * returning whether the record was newly created along with the delivery.
   */
  createIfNotExists(
    input: CreateWebhookDeliveryInput,
    options?: WebhookDeliveryOptions
  ): Promise<{ created: boolean; delivery: GitHubWebhookDelivery }>;

  /**
   * Finds a delivery by its GitHub delivery GUID.
   */
  findByDeliveryId(
    deliveryId: string,
    options?: WebhookDeliveryOptions
  ): Promise<GitHubWebhookDelivery | null>;

  /**
   * Updates delivery status, error message, or processed timestamp.
   */
  updateStatus(
    deliveryId: string,
    status: GitHubDeliveryStatus,
    errorMessage?: string | null,
    processedAt?: Date | null,
    options?: WebhookDeliveryOptions
  ): Promise<GitHubWebhookDelivery>;
}
