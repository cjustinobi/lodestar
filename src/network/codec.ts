/**
 * @module network
 */

import {deserialize, serialize} from "@chainsafe/ssz";

import {
  Hello, Goodbye, Status,
  BeaconBlockRootsRequest, BeaconBlockHeadersRequest, BeaconBlockBodiesRequest,
  BeaconStatesRequest, RequestBody,
  BeaconBlockRootsResponse, BeaconBlockHeadersResponse, BeaconBlockBodiesResponse,
  BeaconStatesResponse, ResponseBody, WireResponse, WireRequest,
} from "../types";

export type RequestId = string;

export enum Method {
  Hello = 0,
  Goodbye = 1,
  Status = 2,
  BeaconBlockRoots = 10,
  BeaconBlockHeaders = 11,
  BeaconBlockBodies = 12,
  BeaconStates = 13,
}

// Encode

export function encodeRequest(id: RequestId, method: Method, body: RequestBody): Buffer {
  let encodedBody: Buffer;
  switch (method) {
    case Method.Hello:
      encodedBody = serialize(body, Hello);
      break;
    case Method.Goodbye:
      encodedBody = serialize(body, Goodbye);
      break;
    case Method.Status:
      encodedBody = serialize(body, Status);
      break;
    case Method.BeaconBlockRoots:
      encodedBody = serialize(body, BeaconBlockRootsRequest);
      break;
    case Method.BeaconBlockHeaders:
      encodedBody = serialize(body, BeaconBlockHeadersRequest);
      break;
    case Method.BeaconBlockBodies:
      encodedBody = serialize(body, BeaconBlockBodiesRequest);
      break;
    case Method.BeaconStates:
      encodedBody = serialize(body, BeaconStatesRequest);
      break;
    default:
      throw new Error(`Invalid method ${method}`);
  }
  const request: WireRequest = {
    id: Buffer.from(id, 'hex'),
    method: method,
    body: encodedBody,
  };
  return serialize(request, WireRequest);
}

export function encodeResponse(id: RequestId, method: Method, responseCode: number, result: ResponseBody): Buffer {
  const response: WireResponse = {
    id: Buffer.from(id, 'hex'),
    responseCode,
    result: Buffer.alloc(0),
  };
  if (responseCode !== 0) { // error response
    return serialize(response, WireResponse);
  }
  switch (method) {
    case Method.Hello:
      response.result = serialize(result, Hello);
      break;
    case Method.Goodbye:
      response.result = serialize(result, Goodbye);
      break;
    case Method.Status:
      response.result = serialize(result, Status);
      break;
    case Method.BeaconBlockRoots:
      response.result = serialize(result, BeaconBlockRootsResponse);
      break;
    case Method.BeaconBlockHeaders:
      response.result = serialize(result, BeaconBlockHeadersResponse);
      break;
    case Method.BeaconBlockBodies:
      response.result = serialize(result, BeaconBlockBodiesResponse);
      break;
    case Method.BeaconStates:
      response.result = serialize(result, BeaconStatesResponse);
      break;
    default:
      throw new Error(`Invalid method ${method}`);
  }
  return serialize(response, WireResponse);
}

// Decode

export function decodeRequestBody(method: Method, body: Buffer): RequestBody {
  switch (method) {
    case Method.Hello:
      return deserialize(body, Hello) as unknown as Hello;
    case Method.Goodbye:
      return deserialize(body, Goodbye) as unknown as Goodbye;
    case Method.Status:
      return deserialize(body, Status) as unknown as Status;
    case Method.BeaconBlockRoots:
      return deserialize(body, BeaconBlockRootsRequest) as unknown as BeaconBlockRootsRequest;
    case Method.BeaconBlockHeaders:
      return deserialize(body, BeaconBlockHeadersRequest) as unknown as BeaconBlockHeadersRequest;
    case Method.BeaconBlockBodies:
      return deserialize(body, BeaconBlockBodiesRequest) as unknown as BeaconBlockBodiesRequest;
    case Method.BeaconStates:
      return deserialize(body, BeaconStatesRequest) as unknown as BeaconStatesRequest;
    default:
      throw new Error(`Invalid method ${method}`);
  }
}

export function decodeResponseBody(method: Method, result: Buffer): ResponseBody {
  switch (method) {
    case Method.Hello:
      return deserialize(result, Hello) as unknown as Hello;
    case Method.Goodbye:
      return deserialize(result, Goodbye) as unknown as Goodbye;
    case Method.Status:
      return deserialize(result, Status) as unknown as Status;
    case Method.BeaconBlockRoots:
      return deserialize(result, BeaconBlockRootsResponse) as unknown as BeaconBlockRootsResponse;
    case Method.BeaconBlockHeaders:
      return deserialize(result, BeaconBlockHeadersResponse) as unknown as BeaconBlockHeadersResponse;
    case Method.BeaconBlockBodies:
      return deserialize(result, BeaconBlockBodiesResponse) as unknown as BeaconBlockBodiesResponse;
    case Method.BeaconStates:
      return deserialize(result, BeaconStatesResponse) as unknown as BeaconStatesResponse;
    default:
      throw new Error(`Invalid method ${method}`);
  }
}

export function sanityCheckData(data: Buffer): boolean {
  return Buffer.isBuffer(data) && data.length >= 10;
}
