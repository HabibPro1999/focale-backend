import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  CommitteeInvitePasswordSetResponseSchema,
  CommitteeInviteResendResponseSchema,
  CommitteeInviteVerifyResponseSchema,
} from "@app/contracts";
import { ResponseContract } from "../../core/response-contract";
import { CommitteeInviteService } from "./abstracts.committee-invite.service";
import {
  CommitteeInviteVerifyDto,
  CommitteeInviteSetPasswordDto,
  CommitteeInviteResendDto,
} from "./abstracts.dto";

// Auth-free even if a caller sends an Authorization header. Tokens stay in POST bodies.
@Controller("api/public/committee/invite")
export class CommitteeInviteController {
  constructor(private readonly invites: CommitteeInviteService) {}
  @Post("verify")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ResponseContract(CommitteeInviteVerifyResponseSchema)
  verify(@Body() body: CommitteeInviteVerifyDto) {
    return this.invites.verifyCommitteeInvite(body.token);
  }
  @Post("set-password")
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ResponseContract(CommitteeInvitePasswordSetResponseSchema)
  setPassword(@Body() body: CommitteeInviteSetPasswordDto) {
    return this.invites.setCommitteeMemberPasswordWithInvite(
      body.token,
      body.password,
    );
  }
  @Post("resend")
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ResponseContract(CommitteeInviteResendResponseSchema)
  resend(@Body() body: CommitteeInviteResendDto) {
    return this.invites.resendCommitteeInviteWithToken(body.token);
  }
}
