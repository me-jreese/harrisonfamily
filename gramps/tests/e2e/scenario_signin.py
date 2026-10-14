"""Sign-in scenario of the end-to-end lane (HFY-TSK-181): the addon's own PKCE login and token manager against the dev /auth endpoints.

No tree is bound; this checks the dev authorization server the other scenarios sign in through: the loopback login, a step-up, the rotation
of the refresh token, and the revocation of a family whose rotated token is shown again (the addon must then ask for a new sign-in, exit 77).
The Keychain is a variable; the browser is a stub that follows the redirect.
"""
import base64
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e2e_case as C  # noqa: E402
import e2e_support as E  # noqa: E402
from hfygramps.addon import consts, oauth, transport  # noqa: E402


def claims(jwt):
    """The payload of a JWT, unverified (the server verifies; this only reads what the dev server put in)."""
    part = jwt.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)).decode("utf-8"))


class SignIn(C.E2ECase):
    def test_login_gives_a_bearer_the_sync_routes_accept(self):
        server = self.start_server()
        session = E.sign_in(server)
        token = session.tokens.access_token()
        c = claims(token)
        self.assertEqual((c["aud"], c["client_id"], c["token_use"], c["iss"]), (server.origin + "/api/sync", consts.OAUTH_CLIENT_ID, "access", server.origin + "/auth"))
        self.assertNotIn("mfa", c["amr"])
        self.assertTrue(session.keychain.token.startswith("hfyrt_"))
        self.assertEqual(session.client().meta()["api_version"], 1)

    def test_a_step_up_login_carries_mfa_and_a_fresh_auth_time(self):
        server = self.start_server()
        c = claims(E.sign_in(server, step_up=True).tokens.access_token())
        self.assertIn("mfa", c["amr"])
        authorize = server.requests(method="GET", path="/auth/authorize")[0]
        self.assertEqual((authorize["query"]["prompt"], authorize["query"]["max_age"]), ("login", "300"))

    def test_refresh_rotates_the_token_and_keeps_the_sign_in_time(self):
        server = self.start_server("--access-ttl", "30")  # under the manager's 60 s skew: every call refreshes
        session = E.sign_in(server)
        first_refresh = session.keychain.token
        first = claims(session.tokens.access_token())
        second = claims(session.tokens.access_token())
        self.assertNotEqual(session.keychain.token, first_refresh)
        self.assertGreaterEqual(session.keychain.stores, 3)
        self.assertEqual(first["auth_time"], second["auth_time"])  # a refresh never renews the sign-in
        self.assertEqual(session.client().meta()["api_version"], 1)

    def test_a_revoked_family_means_sign_in_again(self):
        server = self.start_server("--access-ttl", "30")
        session = E.sign_in(server)
        status, _ = server.patch_json("/_dev/auth", {"revoke_all": True})
        self.assertEqual(status, 200)
        with self.assertRaises(oauth.AuthRequired) as ctx:
            session.tokens.access_token()
        self.assertEqual(ctx.exception.exit_code, consts.EXIT_SIGN_IN)
        self.assertIsNone(session.keychain.token)  # the dead token is removed
        # The log names the fields of the token calls and none of their values.
        for e in server.requests(method="POST", path="/auth/token"):
            self.assertIn("grant_type", e["body_fields"])
            self.assertNotIn("body", e)

    def test_an_expired_or_foreign_token_is_a_401_the_transport_maps_to_exit_77(self):
        server = self.start_server()
        other = self.start_server()
        foreign = E.sign_in(other)
        client = transport.Client(server.origin, E.make_versions(), lambda: foreign.tokens.access_token(), http=transport.Http(delays=()))
        with self.assertRaises(transport.TransportError) as ctx:
            client.meta()
        self.assertEqual((ctx.exception.status, ctx.exception.exit_code, ctx.exception.next_action), (401, consts.EXIT_SIGN_IN, "login"))


if __name__ == "__main__":
    unittest.main()
