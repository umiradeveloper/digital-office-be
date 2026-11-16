import { Module } from '@nestjs/common';
import { RolesController } from './roles/roles.controller';
import { DepartmentsController } from './departments/departments.controller';
import { DelegationsController } from './delegations/delegations.controller';

@Module({ controllers: [RolesController, DepartmentsController, DelegationsController] })
export class OrganizationModule {}
