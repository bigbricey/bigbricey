import companionEndpoint from "./_companion_endpoint.js";
import dataRightsEndpoint from "./_data_rights_endpoint.js";
import feedbackEndpoint from "./_feedback_endpoint.js";
import healthEndpoint from "./_health_endpoint.js";
import recordsEndpoint from "./_records_endpoint.js";
import snapshotsEndpoint from "./_snapshots_endpoint.js";
import { sendJson } from "./_auth.js";

const ROUTES = Object.freeze({
  companion: companionEndpoint,
  "data-rights": dataRightsEndpoint,
  feedback: feedbackEndpoint,
  health: healthEndpoint,
  records: recordsEndpoint,
  snapshots: snapshotsEndpoint,
});

function routeName(req) {
  const queryValue = req.query?.__account_route;
  const selected = Array.isArray(queryValue) ? queryValue[0] : queryValue;
  if (selected) return String(selected).trim().toLowerCase();
  try {
    return String(
      new URL(req.url, `https://${req.headers.host || "bigbricey.com"}`).searchParams.get(
        "__account_route"
      ) || ""
    )
      .trim()
      .toLowerCase();
  } catch {
    return "";
  }
}

export default async function accountGateway(req, res) {
  const name = routeName(req);
  const endpoint = ROUTES[name];
  if (!endpoint) {
    return sendJson(res, 404, { error: "account_route_not_found" });
  }
  return endpoint(req, res);
}
