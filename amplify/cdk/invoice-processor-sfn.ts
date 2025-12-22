/**
 * @file amplify/cdk/invoice-processor-sfn.ts
 * @description AWS Step Functions state machine for async invoice processing
 */

import { Duration, type Stack } from 'aws-cdk-lib';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';

/**
 * Create the invoice processor Step Functions state machine
 *
 * Flow:
 * 1. Start Textract async job (WAIT_FOR_TASK_TOKEN)
 * 2. ALWAYS enhance with Bedrock (passes candidate amounts for intelligent selection)
 * 3. Run matcher
 * 4. Complete
 */
export function createInvoiceProcessorStateMachine(
  stack: Stack,
  textractRequestLambda: NodejsFunction,
  bedrockEnhanceLambda: NodejsFunction,
  matcherLambda: NodejsFunction
): sfn.StateMachine {
  // Success state
  const success = new sfn.Succeed(stack, 'ProcessingComplete', {
    comment: 'Invoice processing completed successfully',
  });

  // Failure state
  const failure = new sfn.Fail(stack, 'ProcessingFailed', {
    cause: 'Invoice processing failed',
    error: 'InvoiceProcessingError',
  });

  // Step 3: Run matcher (defined first since it's referenced by multiple paths)
  const runMatcher = new tasks.LambdaInvoke(stack, 'RunMatcher', {
    lambdaFunction: matcherLambda,
    payload: sfn.TaskInput.fromObject({
      invoiceId: sfn.JsonPath.stringAt('$.invoiceId'),
      userId: sfn.JsonPath.stringAt('$.userId'),
    }),
    resultPath: '$.matchResult',
  });

  // Add retry for matcher
  runMatcher.addRetry({
    maxAttempts: 3,
    backoffRate: 2,
    interval: Duration.seconds(5),
    errors: ['States.TaskFailed', 'States.Timeout'],
  });

  // Connect runMatcher to success
  runMatcher.next(success);

  // Add catch for matcher failures
  runMatcher.addCatch(failure, {
    resultPath: '$.error',
  });

  // Pass state to prepare data for matcher after Bedrock
  const prepareForMatcherAfterBedrock = new sfn.Pass(stack, 'PrepareForMatcherAfterBedrock', {
    parameters: {
      invoiceId: sfn.JsonPath.stringAt('$.invoiceId'),
      userId: sfn.JsonPath.stringAt('$.userId'),
      textractResult: sfn.JsonPath.objectAt('$.textractResult'),
      bedrockResult: sfn.JsonPath.objectAt('$.bedrockResult'),
    },
  });

  prepareForMatcherAfterBedrock.next(runMatcher);

  // Pass state for when Bedrock fails - go directly to matcher with Textract data
  const prepareForMatcherOnBedrockError = new sfn.Pass(stack, 'PrepareForMatcherOnBedrockError', {
    parameters: {
      invoiceId: sfn.JsonPath.stringAt('$.invoiceId'),
      userId: sfn.JsonPath.stringAt('$.userId'),
      textractResult: sfn.JsonPath.objectAt('$.textractResult'),
      bedrockError: sfn.JsonPath.objectAt('$.bedrockError'),
    },
  });

  prepareForMatcherOnBedrockError.next(runMatcher);

  // Step 2: Enhance with Bedrock (for low confidence extractions)
  const enhanceWithBedrock = new tasks.LambdaInvoke(stack, 'EnhanceWithBedrock', {
    lambdaFunction: bedrockEnhanceLambda,
    payload: sfn.TaskInput.fromObject({
      invoiceId: sfn.JsonPath.stringAt('$.invoiceId'),
      userId: sfn.JsonPath.stringAt('$.userId'),
      s3Key: sfn.JsonPath.stringAt('$.s3Key'),
      bucketName: sfn.JsonPath.stringAt('$.bucketName'),
      // textractResult now contains the extracted data directly from synchronous Textract
      extractedData: sfn.JsonPath.objectAt('$.textractResult'),
      confidence: sfn.JsonPath.numberAt('$.textractResult.confidence'),
    }),
    resultPath: '$.bedrockResult',
  });

  // Add retry for Bedrock
  enhanceWithBedrock.addRetry({
    maxAttempts: 3,
    backoffRate: 2,
    interval: Duration.seconds(5),
    errors: ['States.TaskFailed', 'States.Timeout', 'ThrottlingException'],
  });

  enhanceWithBedrock.next(prepareForMatcherAfterBedrock);

  // Add catch for Bedrock failures (continue to matcher anyway with Textract data)
  enhanceWithBedrock.addCatch(prepareForMatcherOnBedrockError, {
    resultPath: '$.bedrockError',
  });

  // Step 1: Start Textract (WAIT_FOR_TASK_TOKEN pattern)
  // This step will pause until textract-retrieve sends SendTaskSuccess/Failure
  const startTextract = new tasks.LambdaInvoke(stack, 'StartTextractJob', {
    lambdaFunction: textractRequestLambda,
    integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
    payload: sfn.TaskInput.fromObject({
      invoiceId: sfn.JsonPath.stringAt('$.invoiceId'),
      userId: sfn.JsonPath.stringAt('$.userId'),
      s3Key: sfn.JsonPath.stringAt('$.s3Key'),
      bucketName: sfn.JsonPath.stringAt('$.bucketName'),
      taskToken: sfn.JsonPath.taskToken,
    }),
    resultPath: '$.textractResult',
    taskTimeout: sfn.Timeout.duration(Duration.minutes(10)),
  });

  // Add retry for Textract rate limiting with exponential backoff
  // Textract has low concurrent request limits, so we need aggressive backoff
  startTextract.addRetry({
    maxAttempts: 5,
    backoffRate: 2.5,
    interval: Duration.seconds(45),
    errors: ['ProvisionedThroughputExceededException', 'ThrottlingException'],
  });

  // Add retry for timeouts
  startTextract.addRetry({
    maxAttempts: 2,
    backoffRate: 2,
    interval: Duration.seconds(10),
    errors: ['States.Timeout'],
  });

  // Add retry for S3 access errors (temporary permissions issues)
  startTextract.addRetry({
    maxAttempts: 3,
    backoffRate: 2,
    interval: Duration.seconds(5),
    errors: ['InvalidS3ObjectException'],
  });

  // Always run Bedrock for intelligent amount/vendor selection
  startTextract.next(enhanceWithBedrock);

  // Add catch for Textract failures
  startTextract.addCatch(failure, {
    resultPath: '$.error',
  });

  // Create the state machine
  return new sfn.StateMachine(stack, 'InvoiceProcessorStateMachine', {
    definitionBody: sfn.DefinitionBody.fromChainable(startTextract),
    timeout: Duration.minutes(15),
    stateMachineName: 'freeagent-bot-invoice-processor',
    tracingEnabled: true,
    comment: 'Invoice processing: Textract extraction -> Bedrock intelligent selection -> Matcher',
  });
}
