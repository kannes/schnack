const url = require('url');
const express = require('express');
const app = express();
const cors = require('cors');
const bodyParser = require('body-parser');
const moment = require('moment');

const RSS = require('rss');
const marked = require('marked');

const dbHandler = require('./db');
const queries = require('./db/queries');
const auth = require('./auth');
const pushHandler = require('./push');
const {
    error,
    getUser,
    isAdmin,
    checkOrigin,
    checkValidComment,
    getSchnackDomain
 } = require('./helper');

const config = require('../config.json');
const awaiting_moderation = [];

marked.setOptions({ sanitize: true });

dbHandler.init()
    .then(db => run(db))
    .catch(err => console.error(err.message));

    function run(db) {
        app.use(cors({
            credentials: true,
            origin: checkOrigin
        }));

        app.use(bodyParser.json());
        app.use(bodyParser.urlencoded({ extended: true }));

        // init session + passport middleware and auth routes
        auth.init(app, db, getSchnackDomain());
        pushHandler.init(app, db, awaiting_moderation);

    app.get('/comments/:slug', (request, reply) => {
        const { slug } = request.params;
        const user = getUser(request);
        const providers = user ? null : auth.providers;

        let query = queries.get_comments;
        let args = [slug, user ? user.id : -1];

        if (isAdmin(user)) {
            user.admin = true;
            query = queries.admin_get_comments;
            args.length = 1;
        }

        db.all(query, args, (err, comments) => {
            if (error(err, request, reply)) return;
            comments.forEach((c) => {
                const m = moment.utc(c.created_at);
                c.created_at_s = config.date_format ? m.format(config.date_format) : m.fromNow();
                c.comment = marked(c.comment.trim());
                c.author_url = auth.getAuthorUrl(c);
            });
            reply.send({ user, auth: providers, slug, comments });
        });
    });

    app.get('/signout', (request, reply) => {
        delete request.session.passport;
        reply.send({ status: 'ok' });
    });

    // POST new comment
    app.post('/comments/:slug', (request, reply) => {
        const { slug } = request.params;
        const { comment, replyTo } = request.body;
        const user = getUser(request);

        if (!user) return error('access denied', request, reply, 403);
        checkValidComment(db, slug, user.id, comment, replyTo, (err) => {
            if (err) return reply.send({ status: 'rejected', reason: err });
            let stmt = db
            .prepare(queries.insert, [user.id, slug, comment, replyTo ? +replyTo : null])
            .run(err => {
                if (err) return error(err, request, reply);
                if (!user.blocked && !user.trusted) {
                    awaiting_moderation.push({slug});
                }
                reply.send({ status: 'ok', id: stmt.lastID });
            });
        });
    });

    // trust/block users or approve/reject comments
    app.post(/\/(?:comment\/(\d+)\/(approve|reject))|(?:user\/(\d+)\/(trust|block))/, (request, reply) => {
        const user = getUser(request);
        if (!isAdmin(user)) return reply.status(403).send(request.params);
        const action = request.params[1] || request.params[3];
        const target_id = +(request.params[0] || request.params[2]);
        db.run(queries[action], target_id, (err) => {
            if (error(err, request, reply)) return;
            reply.send({ status: 'ok' });
        });
    });

    app.get('/success', (request, reply) => {
        reply.send(`<script>
            document.domain = document.domain.split('.').slice(1).join('.');
            window.opener.__schnack_wait_for_oauth();
        </script>`);
    });

    app.get('/', (request, reply) => {
        reply.send({test: 'ok' });
    });

    // rss feed of comments in need of moderation
    app.get('/feed', (request, reply) => {
        var feed = new RSS({
            title: 'Awaiting moderation',
            site_url: config.allow_origin[0]
        });
        db.each(queries.awaiting_moderation, (err, row) => {
            if (err) console.error(err.message);
            feed.item({
                title: `New comment on "${row.slug}"`,
                description: `A new comment on "${row.slug}" is awaiting moderation`,
                url: row.slug+'/'+row.id,
                guid: row.slug+'/'+row.id,
                date: row.created_at
            });
        }, (err) => {
            reply.send(feed.xml({indent: true}));
        });
    });

    // for markdown preview
    app.post('/markdown', (request, reply) => {
        const { comment } = request.body;
        reply.send({ html: marked(comment.trim()) });
    });

    // settings
    app.post('/setting/:property/:value', (request, reply) => {
        const { property, value } = request.params;
        const user = getUser(request);
        if (!isAdmin(user)) return reply.status(403).send(request.params);
        const setting = value ? 1 : 0;
        db.run(queries.set_settings, [property, setting], (err) => {
            if (error(err, request, reply)) return;
            reply.send({ status: 'ok' });
        });
    });

    var server = app.listen(config.port || 3000, (err) => {
        if (err) throw err;
        console.log(`server listening on ${server.address().port}`);
    });
}
