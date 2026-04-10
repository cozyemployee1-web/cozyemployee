const request = require("supertest");

let mockPublishJSON;

jest.mock("@upstash/qstash", () => {
  mockPublishJSON = jest.fn().mockResolvedValue({ messageId: "msg_12345" });
  return {
    Client: jest.fn().mockImplementation(() => {
      return {
        publishJSON: mockPublishJSON,
      };
    }),
  };
});

jest.mock("../../cozyemployee-mesh/mesh-storage", () => {
  return {
    verifyMeshStorage: jest.fn().mockResolvedValue(),
    getMeshRedis: jest.fn().mockReturnValue({}),
    keys: { history: jest.fn() }
  };
});

// Mock @upstash/box
jest.mock("@upstash/box", () => ({
  Box: jest.fn(),
  Agent: jest.fn(),
  BoxApiKey: jest.fn(),
}), { virtual: true }); // Use virtual because it may not be installed at this level

// Mock @upstash/workflow/express to avoid 'Class extends value undefined is not a constructor or null' error
jest.mock("@upstash/workflow/express", () => {
  return {
    serve: jest.fn().mockReturnValue((req, res, next) => next()),
  };
});

const app = require("../src/server");

describe("POST /api/trigger/mesh-conversation", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should return 200 and a messageId when successfully triggering the mesh-conversation workflow", async () => {
    const payload = {
      message: "Hello mesh",
      sessionId: "session_1",
    };

    const response = await request(app)
      .post("/api/trigger/mesh-conversation")
      .send(payload)
      .expect(200);

    expect(response.body).toEqual({
      messageId: "msg_12345",
      workflow: "/api/workflow/mesh-conversation",
    });

    const BASE_URL = process.env.WORKFLOW_URL || "http://127.0.0.1:3002";

    expect(mockPublishJSON).toHaveBeenCalledTimes(1);
    expect(mockPublishJSON).toHaveBeenCalledWith({
      url: `${BASE_URL}/api/workflow/mesh-conversation`,
      body: payload,
    });
  });

  it("should return 500 if upstash client throws an error", async () => {
    mockPublishJSON.mockRejectedValueOnce(new Error("QStash is down"));

    const response = await request(app)
      .post("/api/trigger/mesh-conversation")
      .send({ message: "test" })
      .expect(500);

    expect(response.body).toEqual({
      error: "QStash is down",
    });
  });
});
