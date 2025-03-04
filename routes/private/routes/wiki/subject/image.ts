import * as crypto from 'node:crypto';

import { Type as t } from '@sinclair/typebox';
import * as lo from 'lodash-es';

import { NotAllowedError } from '@app/lib/auth';
import { BadRequestError, NotFoundError, UnexpectedNotFoundError } from '@app/lib/error';
import { fileExtension, SupportedImageExtension, uploadSubjectImage } from '@app/lib/image';
import { Tag } from '@app/lib/openapi';
import { LikeRepo, SubjectImageRepo } from '@app/lib/orm';
import * as orm from '@app/lib/orm';
import { Like } from '@app/lib/orm/entity';
import imaginary from '@app/lib/services/imaginary';
import { SandBox } from '@app/lib/subject';
import * as Subject from '@app/lib/subject';
import * as res from '@app/lib/types/res';
import { requireLogin, requirePermission } from '@app/routes/hooks/pre-handler';
import type { App } from '@app/routes/type';

const CoverList = t.Object(
  {
    current: t.Optional(
      t.Object({
        thumbnail: t.String(),
        raw: t.String(),
      }),
    ),
    covers: t.Array(
      t.Object({
        id: t.Integer(),
        thumbnail: t.String(),
        raw: t.String(),
        creator: res.User,
        voted: t.Boolean(),
      }),
    ),
  },
  { $id: 'CoverList' },
);

export function setup(app: App) {
  app.addSchema(CoverList);
  app.get(
    '/subjects/:subjectID/covers',
    {
      schema: {
        operationId: 'listSubjectCovers',
        tags: [Tag.Wiki],
        params: t.Object({
          subjectID: t.Integer({ examples: [184017] }),
        }),
        response: {
          200: t.Ref(CoverList),
        },
      },
      preHandler: [requireLogin('list subject covers')],
    },
    async ({ params: { subjectID }, auth }) => {
      if (!SandBox.has(subjectID)) {
        throw new BadRequestError('暂时只能修改沙盒条目');
      }

      const s = await orm.fetchSubject(subjectID);
      if (!s) {
        throw new NotFoundError(`subject ${subjectID}`);
      }
      if (s.locked) {
        throw new NotAllowedError(`subject ${subjectID} is locked`);
      }

      const images = await SubjectImageRepo.find({
        where: { subjectID, ban: 0 },
        order: { id: 'asc' },
      });

      if (images.length === 0) {
        return {
          current: undefined,
          covers: [],
        };
      }

      const users = await orm.fetchUsers(images.map((x) => x.uid));
      const likes = lo.groupBy(
        await orm.LikeRepo.findBy({
          relatedID: orm.In(images.map((x) => x.id)),
          type: Like.TYPE_SUBJECT_COVER,
          uid: auth.userID,
          ban: 0,
        }),
        (x) => x.relatedID,
      );

      return {
        current: s.image
          ? {
              thumbnail: `https://lain.bgm.tv/r/400/pic/cover/l/${s.image}`,
              raw: `https://lain.bgm.tv/pic/cover/l/${s.image}`,
            }
          : undefined,
        covers: images.map((x) => {
          const u = users[x.uid];
          if (!u) {
            throw new UnexpectedNotFoundError(`user ${x.uid}`);
          }

          return {
            id: x.id,
            thumbnail: 'https://lain.bgm.tv/r/400/pic/cover/l/' + x.target,
            raw: 'https://lain.bgm.tv/pic/cover/l/' + x.target,
            creator: res.toResUser(u),
            voted: x.id in likes,
          };
        }),
      };
    },
  );

  app.post(
    '/subjects/:subjectID/covers',
    {
      schema: {
        operationId: 'uploadSubjectCover',
        tags: [Tag.Wiki],
        params: t.Object({
          subjectID: t.Integer(),
        }),
        response: {
          200: t.Object({}),
        },
        body: t.Object({
          content: t.String({
            format: 'byte',
            description: 'base64 encoded raw bytes, 4mb size limit on **decoded** size',
          }),
        }),
      },
      preHandler: [
        requireLogin('upload a subject cover'),
        requirePermission('upload subject cover', (auth) => auth.permission.subject_edit ?? false),
      ],
    },
    async ({ body: { content }, auth, params: { subjectID } }) => {
      if (!SandBox.has(subjectID)) {
        throw new BadRequestError('暂时只能修改沙盒条目');
      }
      const raw = Buffer.from(content, 'base64');
      // 4mb
      if (raw.length > 4 * 1024 * 1024) {
        throw new BadRequestError('file too large');
      }

      // validate image
      const res = await imaginary.info(raw);
      const format = res.type;

      if (!format) {
        throw new BadRequestError("not valid image, can' get image format");
      }

      const ext = fileExtension(format);
      if (!ext) {
        throw new BadRequestError(
          `not valid image, only support ${SupportedImageExtension.join(', ')}`,
        );
      }

      const h = crypto.createHash('blake2b512').update(raw).digest('base64url').slice(0, 32);

      const filename = `raw/${h.slice(0, 2)}/${h.slice(2, 4)}/${subjectID}_${h.slice(4)}.${ext}`;

      const s = await orm.fetchSubject(subjectID);
      if (!s) {
        throw new NotFoundError(`subject ${subjectID}`);
      }

      if (s.locked) {
        throw new NotAllowedError('edit a locked subject');
      }
      if (s.redirect) {
        throw new NotAllowedError('edit a locked subject');
      }

      await uploadSubjectImage(filename, raw);

      await Subject.uploadCover({ subjectID: subjectID, filename, uid: auth.userID });

      return {};
    },
  );

  app.post(
    '/subjects/:subjectID/covers/:imageID/vote',
    {
      schema: {
        operationId: 'voteSubjectCover',
        tags: [Tag.Wiki],
        summary: '为条目封面投票',
        params: t.Object({
          subjectID: t.Integer({ exclusiveMinimum: 0 }),
          imageID: t.Integer({ exclusiveMinimum: 0 }),
        }),
        response: {
          200: t.Object({}),
        },
      },
      preHandler: [
        requireLogin('vote for subject cover'),
        requirePermission('vote for subject cover', (auth) => auth.permission.subject_edit),
      ],
    },
    async ({ params: { subjectID, imageID }, auth }) => {
      const image = await SubjectImageRepo.findOneBy({ subjectID, id: imageID, ban: 0 });
      if (!image) {
        throw new NotFoundError(`image(id=${imageID}, subjectID=${subjectID})`);
      }

      await LikeRepo.upsert(
        {
          type: Like.TYPE_SUBJECT_COVER,
          relatedID: imageID,
          uid: auth.userID,
          createdAt: new Date(),
          ban: 0,
        },
        { conflictPaths: [], skipUpdateIfNoValuesChanged: false },
      );

      await Subject.onSubjectVote(subjectID);

      return {};
    },
  );

  app.delete(
    '/subjects/:subjectID/covers/:imageID/vote',
    {
      schema: {
        operationId: 'unvoteSubjectCover',
        tags: [Tag.Wiki],
        summary: '撤消条目封面投票',
        params: t.Object({
          subjectID: t.Integer({ exclusiveMinimum: 0 }),
          imageID: t.Integer({ exclusiveMinimum: 0 }),
        }),
        response: {
          200: t.Object({}),
        },
      },
      preHandler: [
        requireLogin('vote for subject cover'),
        requirePermission('vote for subject cover', (auth) => auth.permission.subject_edit),
      ],
    },
    async ({ params: { subjectID, imageID }, auth }) => {
      const result = await LikeRepo.update(
        {
          type: Like.TYPE_SUBJECT_COVER,
          uid: auth.userID,
          relatedID: imageID,
          ban: 0,
        },
        { ban: 1 },
      );

      if (result.affected) {
        await Subject.onSubjectVote(subjectID);
      }

      return {};
    },
  );
}
