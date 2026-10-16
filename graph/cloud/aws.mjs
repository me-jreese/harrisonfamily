// The AWS side of hfy-graph-render: the DynamoDB context the store view reads, the site bucket and the CloudWatch metric. The SDK is
// imported here, on first use, so the pure modules and their tests load without it.

/** A site bucket over S3: get returns null for a missing key; list returns every key under a prefix. */
export function createSite(s3, sdk, bucket) {
  const missing = (e) => e && (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404);
  return {
    async get(key) {
      try {
        const res = await s3.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
        return Buffer.from(await res.Body.transformToByteArray());
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },
    async put(key, body, contentType) {
      await s3.send(new sdk.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async delete(key) {
      await s3.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async list(prefix) {
      const keys = [];
      let token;
      do {
        const res = await s3.send(new sdk.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of res.Contents ?? []) keys.push(o.Key);
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
  };
}

/** One data point; a failed put is swallowed by the caller (a metric must never mask the error that raised it). */
export function createMetrics(cw, sdk, namespace) {
  return {
    async emit(name, value = 1) {
      await cw.send(new sdk.PutMetricDataCommand({ Namespace: namespace, MetricData: [{ MetricName: name, Value: value, Unit: 'Count' }] }));
    },
  };
}

/** The production dependencies, from the function's environment: TABLE_NAME, SITE_BUCKET, METRICS_NAMESPACE, GRAPH_DEBOUNCE_SECONDS. */
export async function createDeps(env = process.env) {
  const [{ DynamoDBClient }, lib, s3sdk, cwsdk] = await Promise.all([
    import('@aws-sdk/client-dynamodb'),
    import('@aws-sdk/lib-dynamodb'),
    import('@aws-sdk/client-s3'),
    import('@aws-sdk/client-cloudwatch'),
  ]);
  if (!env.TABLE_NAME || !env.SITE_BUCKET) throw new Error('TABLE_NAME and SITE_BUCKET are required');
  const ddb = lib.DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const cmds = { GetCommand: lib.GetCommand, PutCommand: lib.PutCommand, UpdateCommand: lib.UpdateCommand, QueryCommand: lib.QueryCommand };
  const seconds = env.GRAPH_DEBOUNCE_SECONDS === undefined ? 15 : Number(env.GRAPH_DEBOUNCE_SECONDS);
  return {
    ctx: { ddb, cmds, table: env.TABLE_NAME },
    site: createSite(new s3sdk.S3Client({}), s3sdk, env.SITE_BUCKET),
    metrics: createMetrics(new cwsdk.CloudWatchClient({}), cwsdk, env.METRICS_NAMESPACE || 'HFY/SyncRender'),
    debounceMs: Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 15_000,
  };
}
