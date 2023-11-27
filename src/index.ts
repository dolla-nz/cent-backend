import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import qs from "qs";

type Bindings = {
  AKAHU_APP_TOKEN: string;
  AKAHU_APP_SECRET: string;
  KV_CENT_TO_AKAHU: KVNamespace;
  KV_AKAHU_TO_CENT: KVNamespace;
};

type AuthVariables = {
  akahu_user_token: string;
};

const app = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>().basePath("/v1");
const sync = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();

app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  return next();
});

app.get("/auth", async (c) => {
  try {
    const code = c.req.query("code");
    const queryParams = c.req.query();

    if (!code) {
      console.log("no code");
      return c.redirect(convertToRedirect(queryParams));
    }
    console.log("code", code);

    // Exchange the code for an access token
    const exchangeResult = await fetch("https://api.akahu.io/v1/token", {
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        client_id: c.env.AKAHU_APP_TOKEN,
        client_secret: c.env.AKAHU_APP_SECRET,
        redirect_uri: "https://api.cent.nz/v1/auth",
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }).then((res) => res.json());

    console.log("exchangeResult", exchangeResult);

    const { success, access_token } = exchangeResult as {
      success: boolean;
      access_token?: string;
    };

    if (!success || !access_token) {
      return c.redirect(
        convertToRedirect({
          error: "unable_to_exchange_code",
          error_description: "Unable to exchange code for access token",
          state: queryParams.state,
        })
      );
    }

    // Generate a random token for the user
    const token = generateRandomBase64(120);

    await Promise.all([
      c.env.KV_CENT_TO_AKAHU.put(token, access_token),
      c.env.KV_AKAHU_TO_CENT.put(access_token, token),
    ]);

    console.log("stored in kv");

    return c.redirect(
      convertToRedirect({
        token,
        state: queryParams.state,
      })
    );
  } catch (error) {
    console.error(error);
    return c.redirect(
      convertToRedirect({
        error: "unknown_error",
        error_description: "An unknown error occurred. Please try again",
        state: c.req.query("state"),
      })
    );
  }
});

app.delete("/auth", async (c) => {
  // Simpler to duplicate parts of the auth middleware than reuse it
  const tokenHeader = c.req.header("Authorization");

  const cent_token = tokenHeader?.split(" ")[1];

  if (!cent_token) {
    c.status(401);
    throw "Missing token";
  }

  const akahu_user_token = await c.env.KV_CENT_TO_AKAHU.get(cent_token);

  if (!akahu_user_token) {
    c.status(401);
    throw "Invalid token";
  }

  const response = await fetch("https://api.akahu.io/v1/token", {
    headers: {
      Authorization: `Bearer ${akahu_user_token}`,
      "X-Akahu-ID": c.env.AKAHU_APP_TOKEN,
    },
    method: "DELETE",
  });

  const deleteResult = await response.json();

  await Promise.all([
    c.env.KV_CENT_TO_AKAHU.delete(cent_token),
    c.env.KV_AKAHU_TO_CENT.delete(akahu_user_token),
  ]);

  return c.json(deleteResult, response.status);
});

// Auth middleware for /sync/* routes
sync.use("*", async (c, next) => {
  const tokenHeader = c.req.header("Authorization");

  const token = tokenHeader?.split(" ")[1];

  if (!token) {
    throw new HTTPException(401, { message: "Missing authentication token" });
  }

  const akahu_user_token = await c.env.KV_CENT_TO_AKAHU.get(token);

  if (!akahu_user_token) {
    c.status(401);
    throw new HTTPException(401, { message: "Invalid authentication token" });
  }

  c.set("akahu_user_token", akahu_user_token);

  return next();
});

sync.get("/accounts", async (c) => {
  const akahu_user_token = c.get("akahu_user_token");

  const response = await fetch("https://api.akahu.io/v1/accounts", {
    headers: {
      Authorization: `Bearer ${akahu_user_token}`,
      "X-Akahu-ID": c.env.AKAHU_APP_TOKEN,
    },
  });

  const accountsResult = await response.json();

  return c.json(accountsResult, response.status);
});

sync.get("/transactions", async (c) => {
  const queryParams = c.req.query();

  if (queryParams?.cursor === "null") {
    // Save the call to akahu
    return c.json({
      success: false,
      message: "No more results",
    });
  }

  const akahu_user_token = c.get("akahu_user_token");

  const response = await fetch(
    `https://api.akahu.io/v1/transactions?${qs.stringify(queryParams)}`,
    {
      headers: {
        Authorization: `Bearer ${akahu_user_token}`,
        "X-Akahu-ID": c.env.AKAHU_APP_TOKEN,
      },
    }
  );

  const transactionsResult = await response.json();

  return c.json(transactionsResult, response.status);
});

app.route("/sync", sync);

app.onError((err, c) => {
  console.error(err);
  c.status(500);
  return c.json({ success: false, message: "An error occurred" });
});

app.notFound((c) => {
  return c.json({ message: "Not found" }, 404);
});

export default app;

// Utils
const generateRandomBase64 = (length: number) => {
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  const decoder = new TextDecoder("latin1");

  return btoa(decoder.decode(randomValues));
};

type OauthSuccessQueryParams = {
  state: string;
  token: string;
};
type AkahuOauthErrorQueryParams = {
  error: string;
  error_description: string;
  state: string;
};

type OauthResponseQueryParams = Partial<
  OauthSuccessQueryParams | AkahuOauthErrorQueryParams
>;

// Create a redirect URL with the query params
const convertToRedirect = (queryParams: OauthResponseQueryParams): string =>
  `https://script.google.com/macros/d/1TEAUaM4gf2zl-bnxWVI3mPF32ErRs_00kFP18JvwpIgU0Rxb3ncm34Lp/usercallback?${qs.stringify(
    queryParams
  )}`;
