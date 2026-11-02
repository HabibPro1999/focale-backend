import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Put,
  Query,
} from "@nestjs/common";
import { ErrorCodes, UserRole } from "@app/contracts";
import { Auth } from "../../core/auth/auth.decorator";
import { CurrentUser } from "../../core/auth/current-user.decorator";
import { type AuthUser } from "../../core/auth/user-cache";
import { AbstractsCommitteeService } from "./abstracts.committee.service";
import {
  AbstractIdParamDto,
  CommitteeAbstractsQueryDto,
  ReviewAbstractDto,
} from "./abstracts.dto";

/**
 * Committee self-service. `@Auth()` only checks for a valid token; the exact
 * SCIENTIFIC_COMMITTEE role is enforced per request (legacy requireScientificCommittee
 * is an exact-role gate, not the role-or-better semantics of `@Auth(role)`).
 */
@Controller("api/abstracts/committee")
@Auth()
export class AbstractsCommitteeController {
  constructor(private readonly committee: AbstractsCommitteeService) {}

  private assertCommitteeRole(user: AuthUser): void {
    if (user.role !== UserRole.SCIENTIFIC_COMMITTEE) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: "Insufficient permissions",
      });
    }
  }

  @Get("me")
  getProfile(@CurrentUser() user: AuthUser) {
    this.assertCommitteeRole(user);
    return this.committee.getCommitteeProfile(user.id);
  }

  @Get("abstracts")
  listAssigned(
    @Query() { eventId }: CommitteeAbstractsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    this.assertCommitteeRole(user);
    return this.committee.listAssignedAbstracts(eventId, user.id);
  }

  @Get("abstracts/:id")
  getAssignedDetail(
    @Param() { id }: AbstractIdParamDto,
    @CurrentUser() user: AuthUser,
  ) {
    this.assertCommitteeRole(user);
    return this.committee.getAssignedAbstractDetail(id, user.id);
  }

  @Put("abstracts/:id/review")
  review(
    @Param() { id }: AbstractIdParamDto,
    @Body() body: ReviewAbstractDto,
    @CurrentUser() user: AuthUser,
  ) {
    this.assertCommitteeRole(user);
    return this.committee.reviewAssignedAbstract(id, user.id, body);
  }
}
