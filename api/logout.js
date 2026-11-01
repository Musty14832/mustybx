// GET /logout — forget the session on this site.
const { TOKEN_COOKIE, EXP_COOKIE, clearCookie, redirect } = require('./_lib/http');

module.exports = async (req, res) => {
  clearCookie(req, res, TOKEN_COOKIE);
  clearCookie(req, res, EXP_COOKIE);
  redirect(res, '/');
};
