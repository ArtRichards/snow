var validate = require('./validate')
, crypto = require('crypto')
, async = require('async')
, activities = require('./activities')

module.exports = exports = function(app) {
    app.post('/v1/vouchers', app.userAuth, exports.create)
    app.post('/v1/vouchers/:id/redeem', app.userAuth, exports.redeem)
    app.get('/v1/vouchers', app.userAuth, exports.index)
}

exports.createId = function() {
    var id = crypto.randomBytes(5).toString('hex').toUpperCase()
    , hash = crypto.createHash('sha256')
    hash.update(id)

    var checksum = hash.digest('hex').substr(0, 2).toUpperCase()

    return id + checksum
}

/*
CREATE FUNCTION create_voucher (
    vid voucher_id,
    uid int,
    cid currency_id,
    amnt bigint
) RETURNS void AS $$
*/
exports.create = function(req, res, next) {
    if (!validate(req.body, 'voucher_create', res)) return

    if (!req.apiKey.canWithdraw) {
        return res.send(401, {
            name: 'MissingApiKeyPermission',
            message: 'Must have withdraw permission'
        })
    }

    var voucherId = exports.createId()

    req.app.conn.write.query({
        text: [
            'SELECT create_voucher($1, $2, $3, $4)'
        ].join('\n'),
        values: [
            voucherId,
            req.user,
            req.body.currency,
            req.app.cache.parseCurrency(req.body.amount, req.body.currency)
        ]
    }, function(err) {
        if (err) return next(err)

        activities.log(req.user, 'CreateVoucher', {
            currency: req.body.currency,
            amount: req.body.amount
        })

        res.send(201, { voucher: voucherId })
    })
}

exports.index = function(req, res, next) {
    if (!req.apiKey.primary) {
        return res.send(401, {
            name: 'MissingApiKeyPermission',
            message: 'Must be primary api key'
        })
    }

    req.app.conn.read.query({
        text: [
            'SELECT v.voucher_id, h.amount, a.currency_id',
            'FROM voucher v',
            'INNER JOIN "hold" h ON h.hold_id = v.hold_id',
            'INNER JOIN account a ON a.account_id = h.account_id',
            'WHERE a.user_id = $1'
        ].join('\n'),
        values: [req.user]
    }, function(err, dr) {
        if (err) return next(err)
        res.send(201, dr.rows.map(function(row) {
            return {
                code: row.voucher_id,
                currency: row.currency_id,
                amount: req.app.cache.formatCurrency(row.amount, row.currency_id)
            }
        }))
    })
}

/*
CREATE FUNCTION redeem_voucher (
    vid voucher_id,
    duid int
) RETURNS int AS $$
*/
exports.redeem = function(req, res, next) {
    if (!req.apiKey.canDeposit) {
        return res.send(401, {
            name: 'MissingApiKeyPermission',
            message: 'Must have deposit permission'
        })
    }

    async.waterfall([
        function(next) {
            req.app.conn.write.query({
                text: [
                    'SELECT redeem_voucher($1, $2) tid'
                ].join('\n'),
                values: [
                    req.params.id,
                    req.user
                ]
            }, next)
        },

        function(dr, next) {
            if (!dr.rows[0].tid) {
                return res.send(204)
            }

            req.app.conn.read.query({
                text: [
                    'SELECT t.amount, a.currency_id',
                    'FROM "transaction" t',
                    'INNER JOIN account a ON a.account_id = t.credit_account_id',
                    'WHERE t.transaction_id = $1'
                ].join('\n'),
                values: [dr.rows[0].tid]
            }, next)
        },

        function(dr) {
            var row = dr.rows[0]
            res.send(200, {
                currency: row.currency_id,
                amount: req.app.cache.formatCurrency(row.amount, row.currency_id)
            })
        }
    ], next)
}
