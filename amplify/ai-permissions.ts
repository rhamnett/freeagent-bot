/**
 * @file amplify/ai-permissions.ts
 * @description IAM policies for AWS AI services (Textract, Bedrock, Secrets Manager)
 */

import type { Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Attach AI service permissions to a Lambda function role
 */
export function attachAIPermissions(stack: Stack, lambdaRole: iam.IRole, identifier: string): void {
  // Textract for invoice/expense document analysis
  lambdaRole.attachInlinePolicy(
    new iam.Policy(stack, `${identifier}-TextractPolicy`, {
      statements: [
        new iam.PolicyStatement({
          sid: 'AllowTextractAnalyze',
          effect: iam.Effect.ALLOW,
          actions: [
            'textract:AnalyzeDocument',
            'textract:AnalyzeExpense',
            'textract:DetectDocumentText',
          ],
          resources: ['*'],
        }),
      ],
    })
  );

  // Bedrock for Claude models (invoice extraction + vendor matching)
  lambdaRole.attachInlinePolicy(
    new iam.Policy(stack, `${identifier}-BedrockPolicy`, {
      statements: [
        new iam.PolicyStatement({
          sid: 'AllowBedrockInvokeModel',
          effect: iam.Effect.ALLOW,
          actions: ['bedrock:InvokeModel'],
          resources: [
            // Foundation models (direct access)
            'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-haiku-20240307-v1:0',
            'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0',
            'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0',
            'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0',
            'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
            // EU cross-region inference profiles
            'arn:aws:bedrock:*:*:inference-profile/eu.anthropic.claude-3-haiku-20240307-v1:0',
            'arn:aws:bedrock:*:*:inference-profile/eu.anthropic.claude-3-5-sonnet-20241022-v2:0',
            'arn:aws:bedrock:*:*:inference-profile/eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
          ],
        }),
      ],
    })
  );
}

/**
 * Attach Secrets Manager permissions for OAuth token storage
 */
export function attachSecretsManagerPermissions(
  stack: Stack,
  lambdaRole: iam.IRole,
  identifier: string
): void {
  lambdaRole.attachInlinePolicy(
    new iam.Policy(stack, `${identifier}-SecretsManagerPolicy`, {
      statements: [
        new iam.PolicyStatement({
          sid: 'AllowSecretsManagerOAuth',
          effect: iam.Effect.ALLOW,
          actions: [
            'secretsmanager:CreateSecret',
            'secretsmanager:GetSecretValue',
            'secretsmanager:UpdateSecret',
            'secretsmanager:DeleteSecret',
            'secretsmanager:PutSecretValue',
          ],
          resources: [
            // Scoped to freeagent-bot secrets only
            `arn:aws:secretsmanager:*:*:secret:freeagent-bot/*`,
          ],
        }),
      ],
    })
  );
}

/**
 * Attach S3 permissions for invoice processing
 */
export function attachS3Permissions(
  stack: Stack,
  lambdaRole: iam.IRole,
  bucketArn: string,
  identifier: string
): void {
  lambdaRole.attachInlinePolicy(
    new iam.Policy(stack, `${identifier}-S3Policy`, {
      statements: [
        new iam.PolicyStatement({
          sid: 'AllowS3InvoiceAccess',
          effect: iam.Effect.ALLOW,
          actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
          resources: [bucketArn, `${bucketArn}/*`],
        }),
      ],
    })
  );
}

/**
 * Attach Lambda invoke permissions for function chaining
 */
export function attachLambdaInvokePermissions(
  stack: Stack,
  lambdaRole: iam.IRole,
  targetFunctionArns: string[],
  identifier: string
): void {
  lambdaRole.attachInlinePolicy(
    new iam.Policy(stack, `${identifier}-LambdaInvokePolicy`, {
      statements: [
        new iam.PolicyStatement({
          sid: 'AllowLambdaInvoke',
          effect: iam.Effect.ALLOW,
          actions: ['lambda:InvokeFunction'],
          resources: targetFunctionArns,
        }),
      ],
    })
  );
}
