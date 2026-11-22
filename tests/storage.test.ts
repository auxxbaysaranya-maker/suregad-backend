import { beforeEach, describe, expect, it, vi } from "vitest";

const destroy = vi.fn();
const resource = vi.fn();
const upload = vi.fn();

vi.mock("cloudinary", async () => {
  const actual = await vi.importActual<typeof import("cloudinary")>("cloudinary");
  const real = actual.v2;
  return {
    v2: {
      config: real.config.bind(real),
      url: real.url.bind(real),
      utils: real.utils,
      uploader: { destroy, upload },
      api: { resource },
    },
  };
});

async function load() {
  vi.resetModules();
  process.env.CLOUDINARY_CLOUD_NAME = "demo-cloud";
  process.env.CLOUDINARY_API_KEY = "123456789012345";
  process.env.CLOUDINARY_API_SECRET = "test-secret-not-real";
  return import("../src/integrations/storage");
}

describe("Cloudinary storage", () => {
  beforeEach(() => {
    destroy.mockReset().mockResolvedValue({ result: "ok" });
    resource.mockReset();
    upload.mockReset().mockResolvedValue({});
  });

  it("maps keys to Cloudinary public ids, resource and delivery types", async () => {
    const { cloudinaryAsset } = await load();
    expect(cloudinaryAsset("public/product_image/u1/abc.jpg")).toEqual({ publicId: "public/product_image/u1/abc", resourceType: "image", deliveryType: "upload", format: "jpg" });
    expect(cloudinaryAsset("public/product_video/u1/abc.mp4")).toMatchObject({ publicId: "public/product_video/u1/abc", resourceType: "video" });
    expect(cloudinaryAsset("private/business_document/u1/abc.pdf")).toEqual({ publicId: "private/business_document/u1/abc.pdf", resourceType: "raw", deliveryType: "authenticated", format: undefined });
    expect(cloudinaryAsset("private/seller_document/u1/abc.png")).toMatchObject({ resourceType: "image", deliveryType: "authenticated" });
    expect(cloudinaryAsset("suregad/demo/phone-1")).toMatchObject({ publicId: "suregad/demo/phone-1", resourceType: "image" });
  });

  it("signs direct uploads with the same public id the file is delivered from", async () => {
    const storage = await load();
    const image = await storage.signUpload({ purpose: "product_image", contentType: "image/jpeg", size: 1000, userId: "u1" });
    expect(image.method).toBe("POST");
    expect(image.uploadUrl).toBe("https://api.cloudinary.com/v1_1/demo-cloud/image/upload");
    expect(image.key).toMatch(/^public\/product_image\/u1\/[^/]+\.jpg$/);
    expect(image.fields?.public_id).toBe(image.key.replace(/\.jpg$/, ""));
    expect(image.fields?.type).toBe("upload");
    expect(image.fields?.api_key).toBe("123456789012345");
    expect(JSON.stringify(image)).not.toContain("test-secret-not-real");
    expect(image.publicUrl!.split("?")[0]).toMatch(/^https:\/\/res\.cloudinary\.com\/demo-cloud\/image\/upload\/(v1\/)?public\/product_image\/u1\/[^/.]+\.jpg$/);
    expect(image.publicUrl).toContain(`${image.fields!.public_id}.jpg`);

    const pdf = await storage.signUpload({ purpose: "business_document", contentType: "application/pdf", size: 1000, userId: "u1" });
    expect(pdf.uploadUrl).toContain("/raw/upload");
    expect(pdf.fields?.public_id).toBe(pdf.key);
    expect(pdf.fields?.type).toBe("authenticated");
    expect(pdf.publicUrl).toBeUndefined();
  });

  it("builds public and signed private delivery URLs", async () => {
    const storage = await load();
    expect(storage.mediaUrl("public/business_logo/u1/x.webp")!.split("?")[0]).toMatch(/^https:\/\/res\.cloudinary\.com\/demo-cloud\/image\/upload\/(v1\/)?public\/business_logo\/u1\/x\.webp$/);
    const doc = await storage.signedDownload("private/business_document/u1/x.pdf");
    expect(doc.split("?")[0]).toMatch(/^https:\/\/res\.cloudinary\.com\/demo-cloud\/raw\/authenticated\/s--[^/]+--\/.*private\/business_document\/u1\/x\.pdf$/);
    expect(storage.storedImageUrl({ key: "public/product_image/u1/a.jpg", url: "http://localhost:4000/media/public/product_image/u1/a.jpg" })).toContain("res.cloudinary.com");
    expect(storage.storedImageUrl({ key: "https://images.example.com/a.jpg", url: "https://images.example.com/a.jpg" })).toBe("https://images.example.com/a.jpg");
  });

  it("destroys files with the right resource type and skips remote URLs", async () => {
    const storage = await load();
    const removed = await storage.deleteStoredFiles(["public/product_image/u1/a.jpg", "private/business_document/u1/b.pdf", "https://images.example.com/c.jpg", null, "public/product_image/u1/a.jpg"]);
    expect(removed).toBe(2);
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledWith("public/product_image/u1/a", { resource_type: "image", type: "upload", invalidate: true });
    expect(destroy).toHaveBeenCalledWith("private/business_document/u1/b.pdf", { resource_type: "raw", type: "authenticated", invalidate: true });
  });

  it("never fails the caller when Cloudinary rejects a delete", async () => {
    destroy.mockRejectedValue(new Error("network down"));
    const storage = await load();
    await expect(storage.deleteStoredFiles(["public/avatar/u1/a.png"])).resolves.toBe(0);
  });

  it("checks that an uploaded file exists", async () => {
    const storage = await load();
    resource.mockResolvedValueOnce({ public_id: "x" });
    await expect(storage.storedFileExists("public/avatar/u1/a.png")).resolves.toBe(true);
    resource.mockRejectedValueOnce(Object.assign(new Error("not found"), { http_code: 404 }));
    await expect(storage.storedFileExists("public/avatar/u1/b.png")).resolves.toBe(false);
  });

  it("rejects disallowed types and oversized files before signing", async () => {
    const storage = await load();
    await expect(storage.signUpload({ purpose: "product_image", contentType: "application/pdf", size: 10, userId: "u1" })).rejects.toMatchObject({ code: "INVALID_FILE_TYPE" });
    await expect(storage.signUpload({ purpose: "product_image", contentType: "image/png", size: 50 * 1024 * 1024, userId: "u1" })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
});
