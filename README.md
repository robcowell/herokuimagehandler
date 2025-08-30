# **Dynamic Image Service – Heroku + Salesforce AppLink**

This project reimplements the [AWS Dynamic Image Transformation for CloudFront architecture](https://aws.amazon.com/solutions/implementations/dynamic-image-transformation-for-amazon-cloudfront/) entirely on **Heroku**, while retaining **Amazon S3** for storage.

It provides on-demand, cached image transformation and **tight integration with Salesforce** via [Heroku AppLink](https://devcenter.heroku.com/articles/salesforce-applink).

---

## **Architecture**

```scss
Salesforce (Apex / Flow / Agentforce)
    ↕ (via AppLink, user-context aware)
Heroku (dynos)
    ↔  Amazon S3 (original images)
    ↔  Redis (optional hot-cache)
    ↔  Expedited CDN (global edge cache)
```

- **Transformations**: Resize, format conversion, quality adjustments, smart crop (via [`sharp`](https://sharp.pixelplumbing.com/)).
- **Caching**: Strong CDN caching; optional Redis hot-cache or write-back derivatives to S3.
- **Security**: HMAC signatures on URLs; secrets in Heroku Config Vars.
- **Integration**: Published APIs auto-generate Flow and Apex actions through **Heroku AppLink**.

---

## **Features**

- 🔒 **Signed URLs** for security
- ⚡ **CDN edge caching** for global performance
- 📦 **Direct S3 uploads** from Salesforce
- 🔗 **One-click AppLink integration** into Salesforce
- 📊 **Heroku metrics and logs** + optional APM add-ons
- 🔄 **Extensible**: support for smart-cropping, watermarking, and other transformations

---

## **Requirements**

- **Heroku CLI** and access to a team or personal Heroku account
- **Salesforce org** with External Services enabled
- Node.js 18+ (for local development)
- S3 bucket and credentials (with read and optional write permissions)

---

## **Quick Start**

### 1️⃣ Clone & set up

```bash
git clone https://github.com/your-org/dynamic-image-service.git
cd dynamic-image-service
heroku create img-service
```

### 2️⃣ Add buildpacks & dependencies

```bash
heroku buildpacks:add heroku/nodejs
npm install
```

### 3️⃣ Configure environment

```bash
heroku config:set \
  S3_BUCKET=my-image-bucket \
  S3_REGION=us-east-1 \
  AWS_ACCESS_KEY_ID=... \
  AWS_SECRET_ACCESS_KEY=... \
  IMG_SIGNING_SECRET=$(openssl rand -hex 32)
```

4️⃣ Optional add-ons

```bash
# Edge caching
heroku addons:create expedited-cdn -a img-service

# Hot metadata cache
heroku addons:create heroku-redis -a img-service
```

### Local Development

```bash
npm install
npm run dev
# Open http://localhost:5000/health
```

### 🔗 Salesforce Integration with AppLink

**Add AppLink to your Heroku app:**

```bash
heroku addons:create heroku-applink -a img-service
```

**Connect to your Salesforce org:**

```bash
heroku salesforce:connect my-salesforce-org -a img-service
```

**Publish your OpenAPI spec:**

```bash
heroku salesforce:publish-openapi ./openapi.yml -a img-service
```

**Use the generated invocable actions in Flow, Apex, or Agentforce:**

```apex
// Apex example
Map<String, Object> params = new Map<String, Object>{
  'key' => 'products/sku123.jpg',
  'w'   => 800,
  'fmt' => 'webp',
  'q'   => 70
};
Map<String, Object> result = ImageService__image_url.invoke(params);
String url = (String) result.get('url');
System.debug('Image URL: ' + url);
```

**Example API (OpenAPI snippet)**

```yaml
openapi: 3.0.3
info:
  title: Image Service
  version: '1.0'
paths:
  /image-url:
    get:
      summary: Get a signed, cacheable transform URL
      parameters:
        - name: key
          in: query
          required: true
          schema: { type: string }
        - name: w
          in: query
          schema: { type: integer }
        - name: h
          in: query
          schema: { type: integer }
        - name: fmt
          in: query
          schema: { type: string, enum: [webp,avif,jpeg,png] }
        - name: q
          in: query
          schema: { type: integer }
      responses:
        '200':
          description: URL returned
          content:
            application/json:
              schema:
                type: object
                properties:
                  url:
                    type: string
```

### Procfile

```yaml
web: node server.js
```

### Scaling & Performance

- Use Standard-2x or Performance-M dynos for Sharp workloads

- Autoscale on 95th percentile response time

- Keep synchronous transforms <10s to avoid router timeouts

- Offload heavy batch jobs to a worker queue dyno

### Security Best Practices

- Rotate IMG_SIGNING_SECRET regularly

- Use Heroku Pipelines with config promotions

- Enforce HTTPS only traffic via Heroku settings or CDN rules

- Optionally add WAF rules (via CDN provider)

### Observability

- Heroku logs (`heroku logs --tail`)

- AppLink call logs in Salesforce

- Optional add-ons: New Relic, Papertrail

- Monitor for H12 timeouts (30s first byte)

### Future Enhancements

- Smart crop with Rekognition alternatives (if needed)

- Write-back derivatives to S3 for ultra-fast cache hits

- Multi-region replication for S3

- Automatic AVIF/WebP negotiation
